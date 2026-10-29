// Explicit, opt-in server workspace UI. Tokens and remote drafts stay in memory.
(function () {
  'use strict';
  let token = '';
  let role = 'read';
  let workspaceId = '';
  let nextOffset = null;
  let busy = false;
  const shell = document.createElement('div');
  shell.id = 'server-workspace-ui';
  shell.innerHTML = `
    <button id="server-workspace-launcher" type="button" disabled>Server workspaces</button>
    <section id="server-document-banner" aria-label="Server document controls" hidden>
      <span id="server-document-label"></span>
      <button id="server-document-save" type="button">Save to server</button>
      <button id="server-document-reload" type="button">Reload from server</button>
      <span id="server-document-message" role="status"></span>
    </section>
    <dialog id="server-workspace-dialog" aria-labelledby="server-workspace-heading">
      <div class="server-workspace-heading"><h2 id="server-workspace-heading">Server workspaces</h2><button id="server-workspace-close" type="button" aria-label="Close server workspaces">Close</button></div>
      <p>Shared server Markdown, separate from your browser-local workspace. Save explicitly with Ctrl/Cmd+S. Comments, assets, encrypted files and editor sessions are not synchronized.</p>
      <form id="server-workspace-connect">
        <label for="server-workspace-token">Workspace access token (kept in memory only)</label>
        <input id="server-workspace-token" type="password" autocomplete="off" spellcheck="false" required minlength="32">
        <button type="submit">Connect</button>
      </form>
      <div id="server-workspace-connected" hidden>
        <div class="server-workspace-row"><label for="server-workspace-select">Workspace</label><select id="server-workspace-select"></select><button id="server-workspace-refresh" type="button">Refresh</button><button id="server-workspace-disconnect" type="button">Disconnect</button></div>
        <form id="server-workspace-create" class="server-workspace-row"><input id="server-workspace-name" aria-label="New workspace name" placeholder="New workspace name" maxlength="120" required><button type="submit">Create workspace</button></form>
        <form id="server-document-create" class="server-workspace-row"><input id="server-document-path" aria-label="New document path" placeholder="notes/document.md" maxlength="512" required><button type="submit">Create document</button></form>
        <form id="server-document-search" class="server-workspace-row"><input id="server-document-query" aria-label="Search server documents" placeholder="Search paths and Markdown" maxlength="200"><button type="submit">Search</button></form>
        <ul id="server-document-list"></ul>
        <button id="server-document-more" type="button" hidden>Next page</button>
      </div>
      <p id="server-workspace-message" role="status" aria-live="polite"></p>
    </dialog>`;
  document.body.appendChild(shell);
  const el = id => document.getElementById(id);
  const bridge = () => window.MarkdownViewerServerDocuments;
  const dialog = el('server-workspace-dialog');
  const root = () => '/api/workspaces/' + encodeURIComponent(workspaceId);
  const docRoute = doc => '/api/workspaces/' + encodeURIComponent(doc.workspace_id) + '/documents/' + encodeURIComponent(doc.id);

  async function api(path, method = 'GET', body, credential = token) {
    if (!credential) throw new Error('Connect with a workspace access token first.');
    const response = await fetch(path, {
      method, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + credential, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (response.status === 413) throw new Error('Request too large. Your draft is intact; server documents are limited to 10 MiB and JSON requests to 11 MiB.');
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
      throw new Error('Workspace backend unavailable. Deploy the workspace API service and configure its origin and credentials.');
    }
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 409 && value.error === 'revision_conflict') throw new Error('Changed on server. Your draft is intact. Download/copy it, then close this tab and reopen the server version to merge.');
      throw new Error(value.message || 'Workspace request failed (' + response.status + ').');
    }
    return value;
  }

  const bannerElement = el('server-document-banner');
  const bannerLabel = el('server-document-label');
  const saveButton = el('server-document-save');
  const reloadButton = el('server-document-reload');
  let bannerQueued = false;

  function banner() {
    // Status contains metadata only; full Markdown snapshots are for explicit saves.
    const doc = bridge()?.activeStatus();
    const hidden = !doc;
    if (bannerElement.hidden !== hidden) bannerElement.hidden = hidden;
    if (!doc) return;
    const label = (doc.workspaceName || doc.workspace_id) + ' / ' + doc.path + ' · revision ' + doc.revision + (doc.dirty ? ' · UNSAVED' : ' · saved') + (doc.readOnly ? ' · read only' : '');
    if (bannerLabel.textContent !== label) bannerLabel.textContent = label;
    const saveDisabled = Boolean(busy || !token || doc.readOnly || !doc.dirty);
    const reloadDisabled = Boolean(busy || !token);
    if (saveButton.disabled !== saveDisabled) saveButton.disabled = saveDisabled;
    if (reloadButton.disabled !== reloadDisabled) reloadButton.disabled = reloadDisabled;
  }

  function queueBanner() {
    if (bannerQueued) return;
    bannerQueued = true;
    requestAnimationFrame(() => {
      bannerQueued = false;
      banner();
    });
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    el('server-workspace-message').textContent = '';
    el('server-document-message').textContent = '';
    shell.querySelectorAll('button, input, select').forEach(control => {
      if (control.id !== 'server-workspace-close') control.disabled = true;
    });
    banner();
    try { await action(); }
    catch (error) {
      el('server-workspace-message').textContent = error.message;
      el('server-document-message').textContent = error.message;
    } finally {
      busy = false;
      dialog.removeAttribute('aria-busy');
      shell.querySelectorAll('button, input, select').forEach(control => { control.disabled = false; });
      el('server-workspace-create').hidden = Boolean(token) && role !== 'admin';
      el('server-document-create').hidden = role === 'read';
      banner();
    }
  }

  async function documents(offset = 0) {
    const list = el('server-document-list');
    list.replaceChildren();
    if (!workspaceId) { nextOffset = null; el('server-document-more').hidden = true; return; }
    const query = el('server-document-query').value.trim();
    const url = query ? root() + '/search?query=' + encodeURIComponent(query) : root() + '/documents?';
    const data = await api(url + (query ? '&' : '') + 'offset=' + offset + '&limit=100');
    nextOffset = data.next_offset;
    el('server-document-more').hidden = nextOffset === null;
    for (const doc of data.items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = doc.path + ' · r' + doc.revision;
      button.addEventListener('click', () => run(async () => {
        const full = await api(docRoute(doc));
        await bridge().open({ ...full, workspaceName: el('server-workspace-select').selectedOptions[0]?.textContent, readOnly: role === 'read' });
        dialog.close();
      }));
      li.appendChild(button);
      list.appendChild(li);
    }
    if (!data.items.length) { const li = document.createElement('li'); li.textContent = 'No documents found.'; list.appendChild(li); }
  }

  async function workspaces(preferred = workspaceId, credential = token) {
    // Fetch every workspace page rather than silently hiding workspaces past 100.
    let offset = 0;
    const items = [];
    do {
      const data = await api('/api/workspaces?limit=200&offset=' + offset, 'GET', undefined, credential);
      role = data.permissions.role;
      items.push(...data.items);
      offset = data.next_offset;
    } while (offset !== null);
    const select = el('server-workspace-select');
    select.replaceChildren();
    for (const ws of items) { const option = document.createElement('option'); option.value = ws.id; option.textContent = ws.name; select.appendChild(option); }
    workspaceId = items.some(ws => ws.id === preferred) ? preferred : items[0]?.id || '';
    select.value = workspaceId;
  }

  el('server-workspace-launcher').addEventListener('click', () => dialog.showModal());
  el('server-workspace-close').addEventListener('click', () => dialog.close());
  el('server-workspace-connect').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      if (token) throw new Error('Disconnect before changing credentials.');
      const candidate = el('server-workspace-token').value;
      el('server-workspace-token').value = '';
      await workspaces('', candidate);
      token = candidate;
      el('server-workspace-connect').hidden = true;
      el('server-workspace-connected').hidden = false;
      await documents();
    });
  });
  el('server-workspace-disconnect').addEventListener('click', () => run(async () => {
    bridge().disconnect();
    token = ''; workspaceId = ''; role = 'read';
    el('server-workspace-connect').hidden = false;
    el('server-workspace-connected').hidden = true;
    el('server-document-list').replaceChildren();
  }));
  el('server-workspace-select').addEventListener('change', () => run(async () => {
    workspaceId = el('server-workspace-select').value;
    await documents();
  }));
  el('server-workspace-refresh').addEventListener('click', () => run(async () => { await workspaces(); await documents(); }));
  el('server-workspace-create').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const ws = await api('/api/workspaces', 'POST', { name: el('server-workspace-name').value });
      el('server-workspace-name').value = '';
      await workspaces(ws.id); await documents();
    });
  });
  el('server-document-create').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      if (!workspaceId) throw new Error('Create or select a workspace first.');
      const doc = await api(root() + '/documents', 'POST', { path: el('server-document-path').value, content: '' });
      await bridge().open({ ...doc, workspaceName: el('server-workspace-select').selectedOptions[0]?.textContent, readOnly: false });
      el('server-document-path').value = '';
      await documents(); dialog.close();
    });
  });
  el('server-document-search').addEventListener('submit', event => { event.preventDefault(); void run(() => documents()); });
  el('server-document-more').addEventListener('click', () => run(() => documents(nextOffset ?? 0)));
  const save = event => run(async () => {
    const doc = event?.detail?.tabId ? bridge().snapshot(event.detail.tabId) : bridge().active();
    if (!doc || doc.readOnly) return;
    const saved = await api(docRoute(doc), 'PUT', { content: doc.content, expected_revision: doc.revision });
    bridge().saved(doc.tabId, saved);
    el('server-document-message').textContent = 'Saved to server.';
  });
  el('server-document-save').addEventListener('click', save);
  window.addEventListener('markdown-viewer:save-server-document', save);
  el('server-document-reload').addEventListener('click', () => run(async () => {
    const doc = bridge().active();
    if (!doc) return;
    if (doc.dirty) throw new Error('Save or copy/download your draft, then close its tab and reopen the server version. Reload does not overwrite unsaved edits.');
    const latest = await api(docRoute(doc));
    await bridge().open({ ...latest, workspaceName: doc.workspaceName, readOnly: doc.readOnly });
  }));
  function ready() {
    el('server-workspace-launcher').disabled = false;
    document.addEventListener('input', event => {
      if (event.target.id === 'markdown-editor' || event.target.id === 'document-split-editor') queueBanner();
    });
    window.addEventListener('markdown-viewer:server-document-changed', queueBanner);
    banner();
  }
  if (bridge()) ready(); else window.addEventListener('markdown-viewer:ready', ready, { once: true });
})();
