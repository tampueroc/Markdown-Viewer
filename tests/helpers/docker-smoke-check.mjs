// Requires a running Docker daemon; no npm dependencies are needed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8' }).trim();
const image = `markdown-viewer:smoke-${process.pid}`;
let container;
let built = false;

try {
  execFileSync('docker', ['build', '-t', image, '.'], { cwd: root, stdio: 'inherit' });
  built = true;
  container = docker('run', '--detach', '--publish', '127.0.0.1::80', image);
  const port = docker('port', container, '80/tcp').split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.ok) { ready = true; break; }
    } catch { /* Nginx is still starting. */ }
    await delay(250);
  }
  assert.ok(ready, 'Nginx must become ready');

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
  console.log('Docker smoke check passed.');
} finally {
  if (container) docker('rm', '--force', container);
  if (built) docker('image', 'rm', image);
}
