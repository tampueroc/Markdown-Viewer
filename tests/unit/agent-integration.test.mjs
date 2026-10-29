import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../agent-integration.js', import.meta.url), 'utf8');
const context = { TextEncoder, setTimeout, clearTimeout };
context.globalThis = context;
vm.runInNewContext(source, context);
const { createController } = context.MarkdownViewerAgentIntegration;

function setup(decision = 'once') {
  const calls = [];
  const documents = {
    getWorkspaceInfo: mode => ({ permission_mode: mode }),
    listDocuments: options => ({ documents: [], options }),
    readDocument: id => ({ id }),
    searchDocuments: (query, limit) => ({ query, limit }),
    getActiveDocument: () => ({ document: null }),
    createDocument: async (input, ctx) => { await ctx.approve('create'); calls.push(['create', input]); return { created: true }; },
    updateDocument: async (input, ctx) => { await ctx.approve('update'); calls.push(['update', input]); return { updated: true }; }
  };
  const prompts = [];
  const ui = {
    update() {},
    requestApproval: async summary => { prompts.push(summary); return typeof decision === 'function' ? decision() : decision; }
  };
  const controller = createController(documents, ui);
  const call = (method, params = {}, deadline = Date.now() + 5000) => controller.handle({ method, params, deadline });
  return { controller, call, calls, prompts };
}

const update = { document_id: 'tab_1', content: '# New', expected_revision: 'rev_3' };

test('rejects all requests until the extension reports enabled access', async () => {
  const { controller, call } = setup();
  assert.equal((await call('read_document', { document_id: 'a' })).error.code, 'PERMISSION_DENIED');
  controller.setAccess({ active: true, mode: 'read-only' });
  assert.deepEqual((await call('read_document', { document_id: 'a' })).result, { id: 'a' });
  controller.setAccess({ active: true, mode: 'bogus' });
  assert.equal((await call('read_document', { document_id: 'a' })).error.code, 'PERMISSION_DENIED');
});

test('read-only access never reaches write operations', async () => {
  const { controller, call, calls, prompts } = setup();
  controller.setAccess({ active: true, mode: 'read-only' });
  assert.equal((await call('update_document', update)).error.code, 'PERMISSION_DENIED');
  assert.equal((await call('create_document', { name: 'A', content: '' })).error.code, 'PERMISSION_DENIED');
  assert.deepEqual(calls, []);
  assert.deepEqual(prompts, []);
});

test('validates methods and parameters strictly', async () => {
  const { controller, call } = setup();
  controller.setAccess({ active: true, mode: 'read-write' });
  assert.equal((await call('constructor')).error.code, 'UNSUPPORTED_OPERATION');
  assert.equal((await call('__proto__')).error.code, 'UNSUPPORTED_OPERATION');
  assert.equal((await call('read_document', { document_id: 'a', extra: 1 })).error.code, 'INVALID_PARAMETERS');
  assert.equal((await call('read_document', [])).error.code, 'INVALID_PARAMETERS');
  assert.equal((await call('search_documents', { query: ' ' })).error.code, 'INVALID_PARAMETERS');
  assert.equal((await call('list_documents', { limit: 0 })).error.code, 'INVALID_PARAMETERS');
  assert.equal((await call('update_document', { ...update, expected_revision: '3' })).error.code, 'INVALID_PARAMETERS');
  assert.equal((await call('create_document', { name: 'a\nb', content: '' })).error.code, 'INVALID_PARAMETERS');
  assert.equal((await call('create_document', { name: 'big', content: 'x'.repeat(1024 * 1024 + 1) })).error.code, 'INVALID_PARAMETERS');
  assert.deepEqual((await call('search_documents', { query: 'auth' })).result, { query: 'auth', limit: 20 });
});

test('writes require approval and denial prevents the change', async () => {
  const denied = setup('deny');
  denied.controller.setAccess({ active: true, mode: 'read-write' });
  assert.equal((await denied.call('update_document', update)).error.code, 'PERMISSION_DENIED');
  assert.deepEqual(denied.calls, []);

  const once = setup('once');
  once.controller.setAccess({ active: true, mode: 'read-write' });
  assert.equal((await once.call('update_document', update)).result.updated, true);
  await once.call('update_document', update);
  assert.equal(once.prompts.length, 2);
});

test('session approval lasts until access is downgraded', async () => {
  const { controller, call, prompts } = setup('session');
  controller.setAccess({ active: true, mode: 'read-write' });
  await call('update_document', update);
  await call('update_document', update);
  assert.equal(prompts.length, 1);
  assert.equal(controller.getAccess().sessionWritesApproved, true);
  controller.setAccess({ active: true, mode: 'read-only' });
  controller.setAccess({ active: true, mode: 'read-write' });
  await call('update_document', update);
  assert.equal(prompts.length, 2);
});

test('access paused during approval and expired deadlines stop the write', async () => {
  let controllerRef;
  const paused = setup(() => { controllerRef.setAccess(null); return 'once'; });
  controllerRef = paused.controller;
  paused.controller.setAccess({ active: true, mode: 'read-write' });
  assert.equal((await paused.call('update_document', update)).error.code, 'PERMISSION_DENIED');
  assert.deepEqual(paused.calls, []);

  const expired = setup('once');
  expired.controller.setAccess({ active: true, mode: 'read-write' });
  assert.equal((await expired.call('update_document', update, Date.now() - 1)).error.code, 'OPERATION_TIMEOUT');
  assert.deepEqual(expired.calls, []);
});

test('unexpected internal errors are not exposed', async () => {
  const { controller } = setup();
  const failing = createController({ readDocument: () => { throw new Error('IndexedDB path /secret'); } }, null);
  failing.setAccess({ active: true, mode: 'read-only' });
  const outcome = await failing.handle({ method: 'read_document', params: { document_id: 'a' }, deadline: Date.now() + 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.error)), { code: 'STORAGE_FAILURE', message: 'The application could not complete the operation.' });
  assert.ok(controller);
});
