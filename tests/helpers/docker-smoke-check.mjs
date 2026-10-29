// Requires a running Docker daemon; no local npm dependencies are needed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8' }).trim();
const image = `markdown-viewer:smoke-${process.pid}`;
const apiImage = `markdown-viewer-workspaces:smoke-${process.pid}`;
const network = `markdown-viewer-smoke-${process.pid}`;
const volume = `${network}-data`;
const token = randomBytes(32).toString('hex');
const built = [];
let container, apiContainer, networkCreated = false, volumeCreated = false;
const startApi = () => docker('run', '--detach', '--network', network, '--network-alias', 'workspace-api',
  '--mount', `type=volume,source=${volume},target=/data`, '-e', 'WORKSPACE_PUBLIC_ORIGIN=http://localhost',
  '-e', 'WORKSPACE_TOKENS_JSON=' + JSON.stringify([{ token, role: 'admin', workspaces: ['*'] }]), apiImage);

async function waitFor(url, headers = {}) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { /* Container or Docker DNS is still starting. */ }
    await delay(250);
  }
  throw new Error('Container did not become ready: ' + url);
}

try {
  for (const [tag, dockerfile] of [[image, 'Dockerfile'], [apiImage, 'server/Dockerfile']]) {
    execFileSync('docker', ['build', '-f', dockerfile, '-t', tag, '.'], { cwd: root, stdio: 'inherit' });
    built.push(tag);
  }
  docker('network', 'create', network); networkCreated = true;
  docker('volume', 'create', volume); volumeCreated = true;
  apiContainer = startApi();
  container = docker('run', '--detach', '--network', network, '--publish', '127.0.0.1::80', image);
  const port = docker('port', container, '80/tcp').split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base);

  const precache = read('sw.js').match(/const CRITICAL_ASSETS = \[([\s\S]*?)\];/)[1];
  const files = new Set([
    ...[...precache.matchAll(/'\.\/([^']*)'/g)].map(([, path]) => path || 'index.html'),
    'native-markdown-source.js', 'sw.js', 'assets/linked-workspace-guide.md'
  ]);
  for (const path of files) {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), read(path), `${path} must return the actual asset, not SPA HTML`);
    assert.equal(response.headers.get('cache-control'), 'no-cache', path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    if (/\.m?js$/.test(path)) assert.match(response.headers.get('content-type'), /javascript/, path);
    if (/\.md$/.test(path)) assert.match(response.headers.get('content-type'), /text\/plain/, path);
  }
  const response = await fetch(base);
  assert.match(response.headers.get('content-security-policy'), /https:\/\/esm\.sh/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  await response.arrayBuffer();
  for (const path of ['/missing.js', '/missing.mjs', '/missing.md', '/missing.css', '/missing-page', '/api', '/api/share', '/api/media/id', '/live-room', '/live-room/test']) {
    const missing = await fetch(`${base}${path}`);
    assert.equal(missing.status, 404, path);
    assert.equal(missing.headers.get('cache-control'), 'no-cache', path);
    assert.equal(missing.headers.get('x-content-type-options'), 'nosniff', path);
    await missing.arrayBuffer();
  }

  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  await waitFor(base + '/api/workspaces', headers);
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    assert.match(response.headers.get('cache-control'), /no-store/);
    return response.json();
  };
  const unauthorized = await fetch(base + '/api/workspaces');
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  const ws = await api('/api/workspaces', 'POST', { name: 'Container test' });
  const doc = await api(`/api/workspaces/${ws.id}/documents`, 'POST', { path: 'notes/test.md', content: 'Persist me' });
  // Recreate the API container: named-volume data must outlive the process.
  docker('rm', '--force', apiContainer); apiContainer = undefined;
  apiContainer = startApi();
  await waitFor(base + '/api/workspaces', headers);
  const persisted = await api(`/api/workspaces/${ws.id}/documents/${doc.id}`);
  assert.equal(persisted.content, 'Persist me');

  const mcp = await fetch(base + '/mcp', { method: 'POST', headers: { ...headers, Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'docker-smoke', version: '1.0.0' }
    } }) });
  assert.equal(mcp.status, 200);
  assert.equal((await mcp.json()).result.serverInfo.name, 'markdown-viewer-workspaces');
  console.log('Docker smoke check passed: assets, API, MCP and persistent storage.');
} finally {
  // Best-effort cleanup without masking the original failure.
  const clean = (...args) => { try { docker(...args); } catch { console.error('Could not clean Docker resource:', args.at(-1)); } };
  if (container) clean('rm', '--force', container);
  if (apiContainer) clean('rm', '--force', apiContainer);
  if (networkCreated) clean('network', 'rm', network);
  if (volumeCreated) clean('volume', 'rm', volume);
  for (const tag of built) clean('image', 'rm', tag);
}
