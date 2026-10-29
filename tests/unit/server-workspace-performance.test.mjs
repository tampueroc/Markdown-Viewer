import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('server workspace UI uses state/input events, not a periodic polling loop', () => {
  const source = read('server-workspaces.js');
  assert.doesNotMatch(source, /\bsetInterval\s*\(/);
  assert.match(source, /addEventListener\('markdown-viewer:server-document-changed', queueBanner\)/);
  assert.match(source, /activeStatus\(\)/);
  assert.match(source, /if \(bannerLabel\.textContent !== label\)/);
});

test('status excludes Markdown while explicit snapshots preserve it, including split and inactive tabs', () => {
  const source = read('script.js');
  const start = source.indexOf('  function getServerDocumentContent(');
  const end = source.indexOf('  window.MarkdownViewerServerDocuments =', start);
  let reads = 0;
  const state = {
    activeTabId: 'active', secondarySplitTabId: 'secondary',
    markdownEditor: { get value() { reads++; return 'new content'; } },
    documentSplitEditor: { value: 'split content' }
  };
  vm.runInNewContext(source.slice(start, end), state);
  const doc = { id: 'document', workspace_id: 'workspace', path: 'note.md', revision: 1, content: 'saved content' };
  const tab = { id: 'active', serverDocument: doc };
  const status = state.getServerDocumentStatus(tab);
  assert.equal(status.dirty, true);
  assert.equal(status.revision, 1);
  assert.equal('content' in status, false);
  assert.equal(reads, 1);
  assert.equal(state.getServerDocumentSnapshot(tab).content, 'new content');
  assert.equal(doc.content, 'saved content');
  assert.equal(state.getServerDocumentStatus({ id: 'secondary', serverDocument: { ...doc, content: 'split content' } }).dirty, false);
  assert.equal(state.getServerDocumentStatus({ id: 'inactive', content: 'saved content', serverDocument: doc }).dirty, false);
  const before = reads;
  assert.equal(state.getServerDocumentStatus({ id: 'local' }), null);
  assert.equal(reads, before);
});
