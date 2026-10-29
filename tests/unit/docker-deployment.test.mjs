import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const dockerfile = read('Dockerfile');
const nginx = read('nginx.conf');
const index = read('index.html');
const copiedWebSources = [...dockerfile.matchAll(/^COPY (.+) \/usr\/share\/nginx\/html\/(?:\S*)$/gm)]
  .flatMap(match => match[1].split(/\s+/));

function assertPackaged(path) {
  assert.ok(copiedWebSources.some(source => source === path || (source.endsWith('/') && path.startsWith(source))),
    `${path} must be copied into the web image`);
}

test('Docker packages all service-worker precache assets and local HTML dependencies', () => {
  const precache = read('sw.js').match(/const CRITICAL_ASSETS = \[([\s\S]*?)\];/)[1];
  for (const [, asset] of precache.matchAll(/'\.\/([^']*)'/g)) {
    assertPackaged(asset || 'index.html');
  }
  for (const [, asset] of index.matchAll(/\b(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/g)) {
    if (/^(?:https?:|data:|blob:|\/)/.test(asset)) continue;
    assertPackaged(asset);
  }
  assertPackaged('404.html');
  // Dockerignore excludes Markdown by default; runtime Markdown needs exceptions.
  const ignoreRules = read('.dockerignore').split(/\r?\n/);
  for (const asset of ['sample.md', 'assets/linked-workspace-guide.md']) {
    assert.ok(ignoreRules.lastIndexOf(`!${asset}`) > ignoreRules.lastIndexOf('*.md'));
  }
});

test('Nginx CSP matches every HTML meta directive without broadening script permissions', () => {
  const meta = index.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const header = nginx.match(/add_header Content-Security-Policy "([^"]+)" always;/)[1];
  const directives = policy => new Map(policy.split(';').map(value => value.trim()).filter(Boolean)
    .map(value => { const [name, ...sources] = value.split(/\s+/); return [name, sources.sort()]; }));
  const actual = directives(header);
  for (const [name, sources] of directives(meta)) {
    assert.deepEqual(actual.get(name), sources, `CSP directive ${name} must match index.html`);
  }
  assert.deepEqual(actual.get('frame-ancestors'), ["'none'"]);
  assert.ok(!actual.get('script-src').includes("'unsafe-inline'"));
});

test('Nginx revalidates unversioned assets and does not hide missing files behind SPA HTML', () => {
  assert.match(nginx, /add_header Cache-Control "no-cache" always;/);
  assert.doesNotMatch(nginx, /\bimmutable\b|\bexpires\s+1y|try_files[^;]*\/index\.html/);
  assert.match(nginx, /application\/javascript js mjs/);
  assert.match(nginx, /text\/plain md/);
  for (const route of ['api', 'live-room']) {
    assert.ok(nginx.includes(`location ^~ /${route}/ { return 404; }`));
  }
  assert.ok(dockerfile.includes('COPY nginx.conf /etc/nginx/conf.d/default.conf'));
  assert.ok(dockerfile.includes('RUN nginx -t'));
});

test('published images target both Intel and Apple Silicon Linux hosts', () => {
  assert.match(read('.github/workflows/docker-publish.yml'), /platforms: linux\/amd64,linux\/arm64/);
});
