/*
 * Markdown Viewer agent integration (Firefox MCP bridge, protocol v1).
 *
 * This file only provides transport, validation, access checks, write approval
 * and the access indicator. Document operations are supplied by script.js so
 * that they use the application's existing state and persistence logic.
 *
 * Trust model: every script running on this page shares one trust boundary, so
 * page scripts can always reach the same data this module can. This integration
 * does not try to hide data from them. It prevents agent writes from bypassing
 * explicit user approval in the application UI, and it only accepts work after
 * the extension has reported an enabled connection.
 */
(function(root) {
  'use strict';

  const PROTOCOL = 'markdown-viewer-agent';
  const VERSION = 1;
  const MAX_CONTENT_BYTES = 1024 * 1024;
  const MAX_NAME_LENGTH = 255;
  const WRITE_METHODS = new Set(['create_document', 'update_document']);
  const ERROR_CODES = new Set([
    'TAB_UNAVAILABLE', 'PERMISSION_DENIED', 'UNSUPPORTED_OPERATION', 'INVALID_PARAMETERS',
    'DOCUMENT_NOT_FOUND', 'REVISION_CONFLICT', 'UNSAVED_CHANGES', 'STORAGE_FAILURE', 'OPERATION_TIMEOUT'
  ]);

  class AgentError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'AgentError';
      this.code = code;
    }
  }

  function utf8Length(value) {
    return new TextEncoder().encode(value).byteLength;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    // Accept plain objects from any realm (structured clones arrive as plain objects).
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  }

  const FIELD_TYPES = {
    requiredId: function(value) { return typeof value === 'string' && value.length > 0 && value.length <= 200; },
    nullableId: function(value) { return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 200); },
    query: function(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 500; },
    limit: function(value) { return Number.isInteger(value) && value >= 1 && value <= 1000; },
    boolean: function(value) { return typeof value === 'boolean'; },
    // Control characters other than tab are not valid in document names.
    name: function(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_NAME_LENGTH && !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value); },
    content: function(value) { return typeof value === 'string' && utf8Length(value) <= MAX_CONTENT_BYTES; },
    revision: function(value) { return typeof value === 'string' && /^rev_\d{1,15}$/.test(value); }
  };

  // [type, required]
  const SCHEMAS = {
    get_workspace_info: {},
    get_active_document: {},
    list_documents: { folder_id: ['nullableId', false], limit: ['limit', false] },
    read_document: { document_id: ['requiredId', true] },
    search_documents: { query: ['query', true], limit: ['limit', false] },
    create_document: { name: ['name', true], content: ['content', true], folder_id: ['nullableId', false], open: ['boolean', false] },
    update_document: { document_id: ['requiredId', true], content: ['content', true], expected_revision: ['revision', true] }
  };

  function validateParams(method, params) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMAS, method)) {
      throw new AgentError('UNSUPPORTED_OPERATION', 'Unsupported operation.');
    }
    if (!isPlainObject(params)) throw new AgentError('INVALID_PARAMETERS', 'Parameters must be an object.');
    const schema = SCHEMAS[method];
    Object.keys(params).forEach(function(key) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) {
        throw new AgentError('INVALID_PARAMETERS', 'Unexpected parameter: ' + key);
      }
    });
    const clean = {};
    Object.keys(schema).forEach(function(key) {
      const type = schema[key][0];
      const required = schema[key][1];
      if (params[key] === undefined) {
        if (required) throw new AgentError('INVALID_PARAMETERS', 'Missing parameter: ' + key);
        return;
      }
      if (!FIELD_TYPES[type](params[key])) throw new AgentError('INVALID_PARAMETERS', 'Invalid parameter: ' + key);
      clean[key] = params[key];
    });
    return clean;
  }

  function normalizeError(error) {
    if (error && error.name === 'AgentError' && ERROR_CODES.has(error.code)) {
      return { code: error.code, message: String(error.message || error.code).slice(0, 300) };
    }
    // Never forward unexpected internal error details to the agent.
    return { code: 'STORAGE_FAILURE', message: 'The application could not complete the operation.' };
  }

  /**
   * Creates the access-checked request handler. `documents` implements the
   * seven operations; write methods receive an `approve(summary)` callback and
   * must re-validate their preconditions after approval resolves.
   */
  function createController(documents, ui) {
    let access = { active: false, mode: 'disabled' };
    let sessionWritesApproved = false;
    let writeChain = Promise.resolve();

    function setAccess(next) {
      const mode = next && next.active === true && (next.mode === 'read-only' || next.mode === 'read-write') ? next.mode : 'disabled';
      access = { active: mode !== 'disabled', mode: mode };
      if (mode !== 'read-write') sessionWritesApproved = false;
      if (ui) ui.update(access, sessionWritesApproved);
    }

    function revokeSessionApproval() {
      sessionWritesApproved = false;
      if (ui) ui.update(access, sessionWritesApproved);
    }

    function requireWriteAccess() {
      if (!access.active || access.mode !== 'read-write') {
        throw new AgentError('PERMISSION_DENIED', 'Agent write access is not enabled.');
      }
    }

    async function approve(summary, deadline) {
      requireWriteAccess();
      if (sessionWritesApproved) return;
      if (!ui) throw new AgentError('PERMISSION_DENIED', 'Write approval is unavailable.');
      const decision = await ui.requestApproval(summary, deadline);
      if (decision === 'timeout') throw new AgentError('OPERATION_TIMEOUT', 'The write was not approved before the request deadline.');
      if (decision !== 'once' && decision !== 'session') throw new AgentError('PERMISSION_DENIED', 'The user denied the write.');
      if (decision === 'session') {
        sessionWritesApproved = true;
        if (ui) ui.update(access, sessionWritesApproved);
      }
      // Access could have been paused or downgraded while the prompt was open.
      requireWriteAccess();
      if (Date.now() >= deadline) throw new AgentError('OPERATION_TIMEOUT', 'The request deadline passed.');
    }

    async function run(method, params, deadline) {
      if (!access.active) throw new AgentError('PERMISSION_DENIED', 'Agent access is not enabled.');
      const clean = validateParams(method, params);
      if (!WRITE_METHODS.has(method)) {
        switch (method) {
          case 'get_workspace_info': return documents.getWorkspaceInfo(access.mode);
          case 'list_documents': return documents.listDocuments(clean);
          case 'read_document': return documents.readDocument(clean.document_id);
          case 'search_documents': return documents.searchDocuments(clean.query, clean.limit || 20);
          case 'get_active_document': return documents.getActiveDocument();
        }
      }
      requireWriteAccess();
      const context = {
        approve: function(summary) { return approve(summary, deadline); },
        checkDeadline: function() {
          requireWriteAccess();
          if (Date.now() >= deadline) throw new AgentError('OPERATION_TIMEOUT', 'The request deadline passed.');
        }
      };
      // Serialize agent writes so that approvals and commits happen one at a time.
      const operation = writeChain.catch(function() {}).then(function() {
        context.checkDeadline();
        return method === 'create_document'
          ? documents.createDocument(clean, context)
          : documents.updateDocument(clean, context);
      });
      writeChain = operation;
      return operation;
    }

    async function handle(message) {
      const deadline = Number.isFinite(message.deadline) ? message.deadline : Date.now() + 15000;
      try {
        return { result: await run(message.method, message.params, deadline) };
      } catch (error) {
        return { error: normalizeError(error) };
      }
    }

    return {
      handle: handle,
      setAccess: setAccess,
      revokeSessionApproval: revokeSessionApproval,
      getAccess: function() { return { mode: access.mode, active: access.active, sessionWritesApproved: sessionWritesApproved }; }
    };
  }

  function createDomUi(doc) {
    let indicator = null;
    let label = null;
    let revokeButton = null;
    let onRevoke = null;
    let approvalQueue = Promise.resolve();
    let activeDialog = null;

    function ensureIndicator() {
      if (indicator) return;
      indicator = doc.createElement('div');
      indicator.id = 'agent-access-indicator';
      indicator.className = 'agent-access-indicator';
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-live', 'polite');
      indicator.hidden = true;
      label = doc.createElement('span');
      revokeButton = doc.createElement('button');
      revokeButton.type = 'button';
      revokeButton.textContent = 'Ask before writes';
      revokeButton.title = 'Require approval again for each agent write';
      revokeButton.hidden = true;
      revokeButton.addEventListener('click', function() { if (onRevoke) onRevoke(); });
      indicator.append(label, revokeButton);
      doc.body.appendChild(indicator);
    }

    function update(access, sessionWritesApproved) {
      ensureIndicator();
      indicator.hidden = !access.active;
      indicator.dataset.mode = access.mode;
      label.textContent = access.mode === 'read-write'
        ? (sessionWritesApproved ? 'Agent access: read/write (writes allowed this session)' : 'Agent access: read/write (approval required)')
        : 'Agent access: read-only';
      revokeButton.hidden = !(access.active && sessionWritesApproved);
      if (!access.active && activeDialog) activeDialog('deny');
    }

    function showDialog(summary, deadline) {
      return new Promise(function(resolve) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { resolve('timeout'); return; }
        const previousFocus = doc.activeElement;
        const backdrop = doc.createElement('div');
        backdrop.className = 'agent-approval-backdrop';
        const dialog = doc.createElement('div');
        dialog.className = 'agent-approval-dialog';
        dialog.setAttribute('role', 'alertdialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'agent-approval-title');
        dialog.setAttribute('aria-describedby', 'agent-approval-description');
        const title = doc.createElement('h2');
        title.id = 'agent-approval-title';
        title.textContent = 'Allow agent change?';
        const description = doc.createElement('p');
        description.id = 'agent-approval-description';
        description.textContent = summary;
        const actions = doc.createElement('div');
        actions.className = 'agent-approval-actions';
        function button(text, value, primary) {
          const element = doc.createElement('button');
          element.type = 'button';
          element.className = primary ? 'btn btn-primary' : 'btn btn-outline-secondary';
          element.textContent = text;
          element.dataset.agentApproval = value;
          element.addEventListener('click', function() { finish(value); });
          actions.appendChild(element);
          return element;
        }
        const deny = button('Deny', 'deny', false);
        button('Allow for this session', 'session', false);
        button('Allow once', 'once', true);
        dialog.append(title, description, actions);
        backdrop.appendChild(dialog);
        function onKey(event) { if (event.key === 'Escape') finish('deny'); }
        const timer = setTimeout(function() { finish('timeout'); }, remaining);
        let done = false;
        function finish(value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          doc.removeEventListener('keydown', onKey, true);
          backdrop.remove();
          activeDialog = null;
          if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
          resolve(value);
        }
        activeDialog = finish;
        doc.addEventListener('keydown', onKey, true);
        doc.body.appendChild(backdrop);
        deny.focus();
      });
    }

    return {
      update: update,
      setRevokeHandler: function(handler) { onRevoke = handler; },
      requestApproval: function(summary, deadline) {
        const next = approvalQueue.catch(function() {}).then(function() { return showDialog(summary, deadline); });
        approvalQueue = next;
        return next;
      }
    };
  }

  /** Accepts a MessagePort from the extension content script and serves requests on it. */
  function install(documents, options) {
    const win = (options && options.window) || root;
    const ui = createDomUi(win.document);
    const controller = createController(documents, ui);
    ui.setRevokeHandler(controller.revokeSessionApproval);
    let port = null;

    function closePort() {
      if (!port) return;
      try { port.close(); } catch (_) {}
      port = null;
      controller.setAccess(null);
    }

    function onPortMessage(event) {
      const message = event.data;
      if (!isPlainObject(message) || message.protocol !== PROTOCOL || message.version !== VERSION) return;
      const currentPort = event.target;
      if (message.type === 'status') {
        controller.setAccess({ active: message.active === true, mode: message.mode });
        return;
      }
      if (message.type !== 'request' || typeof message.requestId !== 'string' || message.requestId.length > 100 || typeof message.method !== 'string') return;
      controller.handle(message).then(function(outcome) {
        if (currentPort !== port) return;
        currentPort.postMessage(Object.assign({ protocol: PROTOCOL, version: VERSION, type: 'response', requestId: message.requestId }, outcome));
      });
    }

    win.addEventListener('message', function(event) {
      const data = event.data;
      if (event.source !== win || event.origin !== win.location.origin) return;
      if (!isPlainObject(data) || data.protocol !== PROTOCOL || data.version !== VERSION || data.type !== 'connect') return;
      if (!event.ports || event.ports.length !== 1) return;
      // A newer connection (for example after an extension reload) replaces the old one.
      closePort();
      port = event.ports[0];
      port.onmessage = onPortMessage;
      port.postMessage({ protocol: PROTOCOL, version: VERSION, type: 'connected' });
    });
    win.postMessage({ protocol: PROTOCOL, version: VERSION, type: 'ready' }, win.location.origin);
    return controller;
  }

  root.MarkdownViewerAgentIntegration = Object.freeze({
    AgentError: AgentError,
    createController: createController,
    validateParams: validateParams,
    install: install
  });
})(typeof window !== 'undefined' ? window : globalThis);
