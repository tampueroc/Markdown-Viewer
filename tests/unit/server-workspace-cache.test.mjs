import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('service worker never caches API, MCP, bearer-authenticated, or non-GET requests', () => {
  const listeners = new Map();
  vm.runInNewContext(readFileSync(new URL('../../sw.js', import.meta.url), 'utf8'), {
    URL, Set, self: { location: { origin: 'https://markdown.test' }, addEventListener: (name, fn) => listeners.set(name, fn) }
  });
  for (const [path, options] of [
    ['/api/workspaces', {}], ['/api/workspaces/id/documents', {}], ['/mcp', {}],
    ['/mcp', { method: 'POST', body: '{}' }], ['/script.js', { headers: { Authorization: 'Bearer secret' } }],
    ['/anything', { method: 'POST', body: '{}' }]
  ]) {
    let intercepted = false;
    listeners.get('fetch')({ request: new Request('https://markdown.test' + path, options), respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
});
