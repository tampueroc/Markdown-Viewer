const { test, expect } = require('@playwright/test');
const { openApp } = require('../helpers/app');

// Stands in for the Firefox extension content script: it connects over a
// MessagePort exactly as content.js does and sends bridge requests.
async function connectAgent(page, mode) {
  // Wait for the initial workspace save; unsaved documents reject agent updates.
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  await page.evaluate(accessMode => {
    const channel = new MessageChannel();
    const pending = new Map();
    let next = 0;
    channel.port1.onmessage = event => {
      const message = event.data;
      if (message.type === 'connected') {
        channel.port1.postMessage({ protocol: 'markdown-viewer-agent', version: 1, type: 'status', active: true, mode: accessMode });
        return;
      }
      if (message.type === 'response' && pending.has(message.requestId)) {
        pending.get(message.requestId)(message);
        pending.delete(message.requestId);
      }
    };
    window.__agent = {
      call(method, params = {}, deadline = Date.now() + 30000) {
        const requestId = 'test_' + (++next);
        return new Promise(resolve => {
          pending.set(requestId, resolve);
          channel.port1.postMessage({ protocol: 'markdown-viewer-agent', version: 1, type: 'request', requestId, method, params, deadline });
        });
      },
      setStatus(active, statusMode) {
        channel.port1.postMessage({ protocol: 'markdown-viewer-agent', version: 1, type: 'status', active, mode: statusMode });
      }
    };
    window.postMessage({ protocol: 'markdown-viewer-agent', version: 1, type: 'connect' }, location.origin, [channel.port2]);
  }, mode);
  await expect(page.locator('#agent-access-indicator')).toBeVisible();
}

function call(page, method, params) {
  return page.evaluate(([name, input]) => window.__agent.call(name, input), [method, params]);
}

async function activeDocument(page) {
  const { result } = await call(page, 'get_active_document', {});
  expect(result.document).not.toBeNull();
  return result.document;
}

test('read-only agents can discover, read and search but not write', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#agent-access-indicator')).toBeHidden();
  await connectAgent(page, 'read-only');
  await expect(page.locator('#agent-access-indicator')).toContainText('read-only');

  const info = await call(page, 'get_workspace_info', {});
  expect(info.result.permission_mode).toBe('read-only');
  expect(info.result.supported_operations).not.toContain('update_document');

  const active = await activeDocument(page);
  const listed = await call(page, 'list_documents', {});
  expect(listed.result.documents.map(doc => doc.id)).toContain(active.id);

  const read = await call(page, 'read_document', { document_id: active.id });
  expect(read.result.content).toBe(await page.locator('#markdown-editor').inputValue());
  expect(read.result.revision).toMatch(/^rev_\d+$/);

  const search = await call(page, 'search_documents', { query: 'MARKDOWN' });
  expect(search.result.results.length).toBeGreaterThan(0);

  const created = await call(page, 'create_document', { name: 'Denied', content: '# Denied' });
  expect(created.error.code).toBe('PERMISSION_DENIED');
  await expect(page.locator('.agent-approval-dialog')).toHaveCount(0);
  expect((await call(page, 'read_document', { document_id: 'missing' })).error.code).toBe('DOCUMENT_NOT_FOUND');
});

test('approved updates change the saved document and the visible editor', async ({ page }) => {
  await openApp(page);
  await connectAgent(page, 'read-write');
  const active = await activeDocument(page);
  const { result: before } = await call(page, 'read_document', { document_id: active.id });

  const pending = call(page, 'update_document', { document_id: active.id, content: '# Agent update\n\nRefresh-token rotation.', expected_revision: before.revision });
  const dialog = page.locator('.agent-approval-dialog');
  await expect(dialog).toContainText(active.name);
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  const updated = await pending;
  expect(updated.result.updated).toBe(true);
  expect(updated.result.revision).not.toBe(before.revision);
  await expect(page.locator('#markdown-editor')).toHaveValue('# Agent update\n\nRefresh-token rotation.');
  await expect(page.locator('#markdown-preview')).toContainText('Agent update');

  // A stale revision is rejected without changing the document.
  const stale = await call(page, 'update_document', { document_id: active.id, content: 'stale', expected_revision: before.revision });
  expect(stale.error.code).toBe('REVISION_CONFLICT');
  await expect(page.locator('#markdown-editor')).toHaveValue('# Agent update\n\nRefresh-token rotation.');

  await page.reload();
  await expect(page.locator('#markdown-editor')).toHaveValue('# Agent update\n\nRefresh-token rotation.');
});

test('denied writes and unsaved editor changes are never overwritten', async ({ page }) => {
  await openApp(page);
  await connectAgent(page, 'read-write');
  const active = await activeDocument(page);
  const { result: before } = await call(page, 'read_document', { document_id: active.id });

  const denied = call(page, 'update_document', { document_id: active.id, content: 'denied', expected_revision: before.revision });
  await page.locator('.agent-approval-dialog').getByRole('button', { name: 'Deny' }).click();
  expect((await denied).error.code).toBe('PERMISSION_DENIED');
  await expect(page.locator('#markdown-editor')).toHaveValue(before.content);

  // Type without waiting for autosave, then attempt an agent update.
  await page.locator('#markdown-editor').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' user typing');
  const unsaved = await call(page, 'update_document', { document_id: active.id, content: 'agent', expected_revision: before.revision });
  expect(['UNSAVED_CHANGES', 'REVISION_CONFLICT']).toContain(unsaved.error.code);
  await expect(page.locator('#markdown-editor')).toHaveValue(before.content + ' user typing');
  await expect(page.locator('.agent-approval-dialog')).toHaveCount(0);
});

test('created documents appear in the workspace and session approval can be revoked', async ({ page }) => {
  await openApp(page);
  await connectAgent(page, 'read-write');

  const first = call(page, 'create_document', { name: 'Release Plan', content: '# Release Plan\n\n## Milestones', open: true });
  await page.locator('.agent-approval-dialog').getByRole('button', { name: 'Allow for this session' }).click();
  const created = (await first).result;
  expect(created.created).toBe(true);
  await expect(page.locator('#document-sidebar')).toContainText('Release Plan');
  await expect(page.locator('#markdown-editor')).toHaveValue('# Release Plan\n\n## Milestones');

  // Session approval skips the prompt for later writes.
  const second = await call(page, 'create_document', { name: 'Notes', content: 'notes' });
  expect(second.result.created).toBe(true);
  await expect(page.locator('#document-sidebar')).toContainText('Notes');

  await page.locator('#agent-access-indicator').getByRole('button', { name: 'Ask before writes' }).click();
  const third = call(page, 'create_document', { name: 'Third', content: '' });
  await expect(page.locator('.agent-approval-dialog')).toBeVisible();
  // Revoking access closes the prompt and denies the write.
  await page.evaluate(() => window.__agent.setStatus(false, 'disabled'));
  expect((await third).error.code).toBe('PERMISSION_DENIED');
  await expect(page.locator('#agent-access-indicator')).toBeHidden();
  expect((await call(page, 'list_documents', {})).error.code).toBe('PERMISSION_DENIED');
});
