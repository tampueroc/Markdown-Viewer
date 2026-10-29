import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WorkspaceStore } from '../../server/workspaces.mjs';
import { createWorkspaceServer } from '../../server/main.mjs';

const admin = { role: 'admin', workspaces: ['*'] };
const token = 'admin-test-token-012345678901234567890';
const readToken = 'reader-test-token-012345678901234567890';
function memory(t) { const store = new WorkspaceStore(':memory:'); t.after(() => store.close()); return store; }
function workspace(store) { return store.execute('create_workspace', { name: 'Engineering' }, admin); }
const error = (status, code) => value => value.status === status && value.code === code;

test('workspace documents persist across restart with metadata, settings, paths and revisions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'markdown-workspaces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'workspaces.sqlite');
  let store = new WorkspaceStore(filename);
  const ws = workspace(store);
  const doc = store.execute('create_document', { workspace_id: ws.id, path: 'notes/start.md', content: '# Hello' }, admin);
  const updated = store.execute('update_document', { workspace_id: ws.id, document_id: doc.id, content: '# Revised', expected_revision: 1 }, admin);
  assert.equal(updated.revision, 2);
  store.close();
  store = new WorkspaceStore(filename);
  try {
    assert.equal(store.execute('read_document', { workspace_id: ws.id, document_id: doc.id }, admin).content, '# Revised');
    const current = store.execute('get_workspace', { workspace_id: ws.id }, admin);
    assert.equal(current.revision, 3);
    const changed = store.execute('update_workspace', { workspace_id: ws.id, settings: { theme: 'dark' }, expected_revision: 3 }, admin);
    assert.deepEqual(changed.settings, { theme: 'dark' });
  } finally { store.close(); }
});

test('workspace-scoped credentials cannot list, read or mutate other workspaces', t => {
  const store = memory(t), ws = workspace(store), other = workspace(store);
  const scoped = { role: 'write', workspaces: [ws.id] };
  assert.equal(store.execute('list_workspaces', {}, scoped).items.length, 1);
  assert.throws(() => store.execute('get_workspace', { workspace_id: other.id }, scoped), error(403, 'forbidden'));
  assert.throws(() => store.execute('create_workspace', { name: 'No' }, scoped), error(403, 'forbidden'));
  assert.throws(() => store.execute('delete_workspace', { workspace_id: ws.id, expected_revision: 1 }, scoped), error(403, 'forbidden'));
  assert.throws(() => store.execute('create_document', { workspace_id: ws.id, path: 'a.md' }, { role: 'read', workspaces: [ws.id] }), error(403, 'forbidden'));
  assert.deepEqual(store.execute('list_workspaces', {}, { role: 'read', workspaces: [] }).items, []);
});

test('document identity is workspace-bound and paths, pagination, search and collisions are validated', t => {
  const store = memory(t), ws = workspace(store), other = workspace(store);
  const doc = store.execute('create_document', { workspace_id: ws.id, path: 'notes/start.md', content: 'an unusual phrase' }, admin);
  for (const path of ['../a.md', '/a.md', 'a/../b.md', 'a\\b.md', 'a//b.md', 'a.txt', 'a/./b.md', 'a\u0000.md']) {
    assert.throws(() => store.execute('create_document', { workspace_id: ws.id, path }, admin), error(400, 'invalid_input'));
  }
  assert.throws(() => store.execute('create_document', { workspace_id: ws.id, path: 'notes/start.md' }, admin), error(409, 'path_conflict'));
  assert.throws(() => store.execute('read_document', { workspace_id: other.id, document_id: doc.id }, admin), error(404, 'not_found'));
  store.execute('create_document', { workspace_id: ws.id, path: 'z.md' }, admin);
  const first = store.execute('list_documents', { workspace_id: ws.id, limit: 1 }, admin);
  assert.equal(first.next_offset, 1);
  assert.equal(first.items[0].content, undefined);
  assert.equal(store.execute('list_documents', { workspace_id: ws.id, limit: 1, offset: 1 }, admin).next_offset, null);
  assert.equal(store.execute('search_documents', { workspace_id: ws.id, query: 'unusual' }, admin).items[0].id, doc.id);
  assert.throws(() => store.execute('list_documents', { workspace_id: ws.id, unexpected: true }, admin), error(400, 'invalid_input'));
});

test('stale updates and deletes preserve documents and stale workspace deletes preserve new work', t => {
  const store = memory(t), ws = workspace(store);
  const doc = store.execute('create_document', { workspace_id: ws.id, path: 'a.md', content: 'first' }, admin);
  store.execute('update_document', { workspace_id: ws.id, document_id: doc.id, content: 'second', expected_revision: 1 }, admin);
  assert.throws(() => store.execute('update_document', { workspace_id: ws.id, document_id: doc.id, content: 'lost edit', expected_revision: 1 }, admin), error(409, 'revision_conflict'));
  assert.throws(() => store.execute('delete_document', { workspace_id: ws.id, document_id: doc.id, expected_revision: 1 }, admin), error(409, 'revision_conflict'));
  assert.throws(() => store.execute('delete_workspace', { workspace_id: ws.id, expected_revision: 1 }, admin), error(409, 'revision_conflict'));
  assert.equal(store.execute('read_document', { workspace_id: ws.id, document_id: doc.id }, admin).content, 'second');
  const rev = store.execute('get_workspace', { workspace_id: ws.id }, admin).revision;
  store.execute('delete_workspace', { workspace_id: ws.id, expected_revision: rev }, admin);
  assert.equal(store.db.prepare('SELECT count(*) n FROM documents').get().n, 0);
});

async function serve(t) {
  const server = createWorkspaceServer({ database: ':memory:', publicOrigin: 'https://markdown.example.test', tokens: [
    { token, ...admin }, { token: readToken, role: 'read', workspaces: ['*'] }
  ] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, method = 'GET', body, credential = token, headers = {}) => {
    const response = await fetch(base + path, { method, headers: {
      Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { api, base };
}

test('REST authenticates, rejects cross-origin requests, never caches, and enforces revisions', async t => {
  const { api } = await serve(t);
  assert.equal((await api('/api/workspaces', 'GET', undefined, 'bad')).status, 401);
  assert.equal((await api('/api/workspaces', 'GET', undefined, token, { Origin: 'https://evil.example' })).status, 403);
  const created = await api('/api/workspaces', 'POST', { name: 'Shared' });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.headers.get('vary'), 'Authorization, Origin');
  assert.equal(created.headers.get('access-control-allow-origin'), null);
  const root = `/api/workspaces/${created.body.id}`;
  const doc = await api(root + '/documents', 'POST', { path: 'test.md', content: 'Hello' });
  assert.equal(doc.status, 201);
  const route = root + '/documents/' + doc.body.id;
  assert.equal((await api(route, 'PUT', { content: 'changed', expected_revision: 1 })).status, 200);
  assert.equal((await api(route, 'PUT', { content: 'stale', expected_revision: 1 })).status, 409);
  assert.equal((await api(route, 'DELETE', { expected_revision: 1 })).status, 409);
  assert.equal((await api(route, 'PUT', { content: 'forbidden', expected_revision: 2 }, readToken)).status, 403);
  assert.equal((await api(root + '/search?query=changed')).body.items.length, 1);
  assert.equal((await api(route)).body.content, 'changed');
  assert.equal((await api(root + '/documents?limit=201')).status, 400);
  assert.equal((await api(route, 'DELETE', { expected_revision: 2 })).status, 200);
});

test('official MCP client discovers tools and uses the same workspace data and permissions as REST', async t => {
  const { api, base } = await serve(t);
  const ws = (await api('/api/workspaces', 'POST', { name: 'Agent workspace' })).body;
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  const created = await client.callTool({ name: 'create_document', arguments: { workspace_id: ws.id, path: 'agent/note.md', content: 'Written through MCP' } });
  assert.ok(!created.isError, JSON.stringify(created));
  const doc = JSON.parse(created.content[0].text);
  assert.equal((await api(`/api/workspaces/${ws.id}/documents/${doc.id}`)).body.content, 'Written through MCP');
  const conflict = await client.callTool({ name: 'update_document', arguments: { workspace_id: ws.id, document_id: doc.id, content: 'no', expected_revision: 2 } });
  assert.equal(conflict.isError, true);
  assert.equal(JSON.parse(conflict.content[0].text).status, 409);
  const reader = new Client({ name: 'reader-test', version: '1.0.0' });
  await reader.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${readToken}` } } }));
  t.after(() => reader.close());
  const denied = await reader.callTool({ name: 'create_document', arguments: { workspace_id: ws.id, path: 'denied.md' } });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).status, 403);
});

test('server fails closed with no credentials or malformed public origin', () => {
  assert.throws(() => createWorkspaceServer({ database: ':memory:', publicOrigin: 'https://a.test', tokens: [] }));
  assert.throws(() => createWorkspaceServer({ database: ':memory:', publicOrigin: 'https://a.test/', tokens: [{ token, ...admin }] }));
});
