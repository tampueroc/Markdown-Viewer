const { test, expect } = require('@playwright/test');
const { once } = require('node:events');
const { openApp } = require('../helpers/app');

const adminToken = 'browser-admin-token-012345678901234567890';
const readerToken = 'browser-reader-token-012345678901234567890';
let backend;
let apiOrigin;

test.beforeEach(async ({ page, baseURL }) => {
  const { createWorkspaceServer } = await import('../../server/main.mjs');
  backend = createWorkspaceServer({ database: ':memory:', publicOrigin: new URL(baseURL).origin, tokens: [
    { token: adminToken, role: 'admin', workspaces: ['*'] },
    { token: readerToken, role: 'read', workspaces: ['*'] }
  ] });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  apiOrigin = `http://127.0.0.1:${backend.address().port}`;
  await routeApi(page);
});

test.afterEach(async () => {
  if (!backend) return;
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
});

async function routeApi(page) {
  await page.route('**/api/workspaces**', async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: apiOrigin + url.pathname + url.search });
    await route.fulfill({ response });
  });
}
async function api(path, method = 'GET', body) {
  const response = await fetch(apiOrigin + path, { method, headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok).toBe(true);
  return response.json();
}
async function connect(page, credential = adminToken) {
  await page.getByRole('button', { name: 'Server workspaces', exact: true }).click();
  await page.locator('#server-workspace-token').fill(credential);
  await page.locator('#server-workspace-connect').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('#server-workspace-connected')).toBeVisible();
}

test('browser and agent share workspace documents; stale saves preserve both versions and credentials stay in memory', async ({ page, context }) => {
  expect(await openApp(page)).toEqual([]);
  await connect(page);
  await page.getByRole('textbox', { name: 'New workspace name' }).fill('Engineering');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.locator('#server-workspace-select')).toHaveValue(/.+/);
  const workspaceId = await page.locator('#server-workspace-select').inputValue();
  await page.getByRole('textbox', { name: 'New document path' }).fill('notes/start.md');
  await page.getByRole('button', { name: 'Create document', exact: true }).click();
  await expect(page.locator('#server-document-banner')).toBeVisible();
  await page.locator('#markdown-editor').fill('# Browser version');
  await page.locator('#markdown-editor').press('ControlOrMeta+s');
  await expect(page.locator('#server-document-label')).toContainText('revision 2 · saved');
  const doc = (await api(`/api/workspaces/${workspaceId}/documents`)).items[0];
  await api(`/api/workspaces/${workspaceId}/documents/${doc.id}`, 'PUT', { content: '# Agent version', expected_revision: 2 });
  await page.locator('#markdown-editor').fill('# Unsaved browser draft');
  await page.getByRole('button', { name: 'Save to server', exact: true }).click();
  await expect(page.locator('#server-document-message')).toContainText('Changed on server');
  await expect(page.locator('#markdown-editor')).toHaveValue('# Unsaved browser draft');
  expect((await api(`/api/workspaces/${workspaceId}/documents/${doc.id}`)).content).toBe('# Agent version');

  await page.getByRole('button', { name: 'Reload from server', exact: true }).click();
  await expect(page.locator('#server-document-message')).toContainText('Save or copy/download your draft');
  await expect(page.locator('#markdown-editor')).toHaveValue('# Unsaved browser draft');
  const local = await page.evaluate(async () => {
    const storage = new window.MarkdownWorkspaceStorage();
    await storage.init();
    return { docs: await storage.listDocumentMetadata(), local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) };
  });
  expect(local.docs.some(item => item.kind === 'server-document')).toBe(false);
  expect(local.local).not.toContain(adminToken);
  expect(local.session).not.toContain(adminToken);
  expect(local.local).not.toContain('Unsaved browser draft');

  const reader = await context.newPage();
  await routeApi(reader);
  expect(await openApp(reader)).toEqual([]);
  await connect(reader, readerToken);
  await reader.getByRole('button', { name: 'notes/start.md · r3', exact: true }).click();
  await expect(reader.locator('#markdown-editor')).toHaveValue('# Agent version');
  await expect(reader.locator('#markdown-editor')).not.toBeEditable();
  await expect(reader.getByRole('button', { name: 'Save to server', exact: true })).toBeDisabled();
});

test('closing or disconnecting an unsaved server tab requires preserving or explicitly discarding its draft', async ({ page }) => {
  const ws = await api('/api/workspaces', 'POST', { name: 'Draft protection' });
  await api(`/api/workspaces/${ws.id}/documents`, 'POST', { path: 'draft.md', content: 'saved' });
  await openApp(page);
  await connect(page);
  await page.getByRole('button', { name: 'draft.md · r1', exact: true }).click();
  await expect(page.locator('#server-workspace-dialog')).not.toBeVisible();
  await expect(page.locator('#markdown-editor')).toHaveValue('saved');
  await page.locator('#markdown-editor').fill('unsaved');
  await page.getByRole('button', { name: 'Server workspaces', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.locator('#server-workspace-message')).toContainText('Save or close unsaved server documents');
  await page.getByRole('button', { name: 'Close server workspaces', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#tab-list .tab-item.active .tab-close-btn').click();
  await expect(page.locator('#markdown-editor')).toHaveValue('unsaved');
  await expect(page.locator('#server-document-banner')).toBeVisible();
});

test('server workspace UI does no idle polling, snapshot reads, requests or banner rewrites', async ({ page }) => {
  const ws = await api('/api/workspaces', 'POST', { name: 'Idle performance' });
  await api(`/api/workspaces/${ws.id}/documents`, 'POST', { path: 'large.md', content: '# Large document\n\n' + 'Plain text paragraph.\n\n'.repeat(4000) });
  await openApp(page);
  await connect(page);
  await page.getByRole('button', { name: 'large.md · r1', exact: true }).click();
  await expect(page.locator('#server-document-banner')).toBeVisible();
  await expect(page.locator('#server-workspace-dialog')).not.toBeVisible();
  // Let one-off startup/preview work finish before observing steady-state work.
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const original = window.MarkdownViewerServerDocuments;
    window.__serverUiWork = { snapshots: 0, statuses: 0, mutations: 0 };
    window.MarkdownViewerServerDocuments = Object.freeze({ ...original,
      active: () => { window.__serverUiWork.snapshots++; return original.active(); },
      activeStatus: () => { window.__serverUiWork.statuses++; return original.activeStatus(); }
    });
    const observer = new MutationObserver(records => { window.__serverUiWork.mutations += records.length; });
    observer.observe(document.getElementById('server-document-banner'), { childList: true, subtree: true, characterData: true, attributes: true });
    const status = original.activeStatus();
    if ('content' in status) throw new Error('Banner status must not expose document content');
  });
  let apiRequests = 0;
  page.on('request', request => { if (/\/(?:api\/workspaces|mcp)(?:[/?]|$)/.test(new URL(request.url()).pathname)) apiRequests++; });
  await page.waitForTimeout(1600);
  expect(await page.evaluate(() => window.__serverUiWork)).toEqual({ snapshots: 0, statuses: 0, mutations: 0 });
  expect(apiRequests).toBe(0);
  // Even redundant state notifications should coalesce and leave identical DOM alone.
  await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) window.dispatchEvent(new Event('markdown-viewer:server-document-changed'));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  expect(await page.evaluate(() => window.__serverUiWork)).toEqual({ snapshots: 0, statuses: 1, mutations: 0 });
});

test('event-driven banner follows edits, tab switches, saves and closing without polling', async ({ page }) => {
  const ws = await api('/api/workspaces', 'POST', { name: 'Event updates' });
  await api(`/api/workspaces/${ws.id}/documents`, 'POST', { path: 'events.md', content: 'initial' });
  await openApp(page);
  await connect(page);
  await page.getByRole('button', { name: 'events.md · r1', exact: true }).click();
  await expect(page.locator('#server-workspace-dialog')).not.toBeVisible();
  await expect(page.locator('#server-document-label')).toContainText('revision 1 · saved');
  const tabId = await page.evaluate(() => window.MarkdownViewerServerDocuments.activeStatus().tabId);
  await page.locator('#markdown-editor').fill('edited');
  await expect(page.locator('#server-document-label')).toContainText('UNSAVED');
  await page.locator('#tab-list .tab-item:not(.active)').first().click();
  await expect(page.locator('#server-document-banner')).toBeHidden();
  await page.locator(`#tab-list .tab-item[data-tab-id="${tabId}"]`).click();
  await expect(page.locator('#server-document-banner')).toBeVisible();
  await expect(page.locator('#server-document-label')).toContainText('UNSAVED');
  await page.getByRole('button', { name: 'Save to server', exact: true }).click();
  await expect(page.locator('#server-document-label')).toContainText('revision 2 · saved');
  await page.locator('#tab-list .tab-item.active .tab-close-btn').click();
  await expect(page.locator('#server-document-banner')).toBeHidden();
});

test('typing during an in-flight save remains an unsaved draft after the save succeeds', async ({ page }) => {
  const ws = await api('/api/workspaces', 'POST', { name: 'Concurrent edits' });
  await api(`/api/workspaces/${ws.id}/documents`, 'POST', { path: 'concurrent.md', content: 'initial' });
  await openApp(page);
  await connect(page);
  await page.getByRole('button', { name: 'concurrent.md · r1', exact: true }).click();
  await expect(page.locator('#server-workspace-dialog')).not.toBeVisible();
  await expect(page.locator('#markdown-editor')).toHaveValue('initial');
  await page.locator('#markdown-editor').fill('save this snapshot');
  let release, arrived;
  const pending = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/workspaces/*/documents/*', async route => {
    if (route.request().method() === 'PUT') { arrived(); await gate; }
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: apiOrigin + url.pathname });
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Save to server', exact: true }).click();
  await pending;
  await page.locator('#markdown-editor').fill('newer edit during save');
  release();
  await expect(page.locator('#server-document-label')).toContainText('revision 2 · UNSAVED');
  await expect(page.locator('#markdown-editor')).toHaveValue('newer edit during save');
});
