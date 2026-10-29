import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export class WorkspaceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new WorkspaceError(status, code, message); };
const id = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const content = z.string().refine(value => Buffer.byteLength(value) <= 10 * 1024 * 1024, 'Maximum document size is 10 MiB');
const path = z.string().min(1).max(512).refine(value => {
  const segments = value.split('/');
  return !/[\\\x00-\x1f\x7f]/.test(value) && segments.length <= 20 &&
    segments.every(part => part && part !== '.' && part !== '..') && /\.(?:md|markdown)$/i.test(value);
}, 'Use a relative Markdown path without empty, dot, or parent segments');
const settings = z.record(z.string().max(100), z.union([z.string().max(2000), z.boolean(), z.number().finite(), z.null()]))
  .refine(value => JSON.stringify(value).length <= 16000, 'Workspace settings exceed 16 KB');
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) };

// One validated command surface is used by REST and MCP. IDs are opaque; paths
// describe logical folders and are never interpolated into filesystem paths.
export const commands = {
  list_workspaces: { schema: z.object(page).strict(), read: true },
  get_workspace: { schema: z.object({ workspace_id: id }).strict(), read: true },
  create_workspace: { schema: z.object({ name, settings: settings.default({}) }).strict(), admin: true },
  update_workspace: { schema: z.object({ workspace_id: id, name: name.optional(), settings: settings.optional(), expected_revision: revision }).strict() },
  delete_workspace: { schema: z.object({ workspace_id: id, expected_revision: revision }).strict(), admin: true, destructive: true },
  list_documents: { schema: z.object({ workspace_id: id, ...page }).strict(), read: true },
  read_document: { schema: z.object({ workspace_id: id, document_id: id }).strict(), read: true },
  create_document: { schema: z.object({ workspace_id: id, path, content: content.default('') }).strict() },
  update_document: { schema: z.object({ workspace_id: id, document_id: id, content, path: path.optional(), expected_revision: revision }).strict() },
  delete_document: { schema: z.object({ workspace_id: id, document_id: id, expected_revision: revision }).strict(), destructive: true },
  search_documents: { schema: z.object({ workspace_id: id, query: z.string().min(1).max(200), ...page }).strict(), read: true }
};

export class WorkspaceStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        path TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id, path)
      );
      CREATE INDEX IF NOT EXISTS document_workspace ON documents(workspace_id, path);`);
  }
  close() { this.db.close(); }
  workspace(id) {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    if (!row) fail(404, 'not_found', 'Workspace not found');
    return { ...row, settings: JSON.parse(row.settings) };
  }
  document(workspace, id) {
    const row = this.db.prepare('SELECT * FROM documents WHERE workspace_id=? AND id=?').get(workspace, id);
    if (!row) fail(404, 'not_found', 'Document not found');
    return { ...row };
  }
  checkRevision(actual, expected) {
    if (actual !== expected) fail(409, 'revision_conflict', 'Changed elsewhere. Read the latest revision and merge your changes before retrying.');
  }
  execute(command, input, principal) {
    const spec = commands[command];
    if (!spec) fail(404, 'unknown_command', 'Unknown workspace command');
    const parsed = spec.schema.safeParse(input);
    if (!parsed.success) fail(400, 'invalid_input', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    const a = parsed.data;
    const all = principal.workspaces.includes('*');
    if ((spec.admin && (principal.role !== 'admin' || !all)) || (!spec.read && principal.role === 'read')) {
      fail(403, 'forbidden', 'This credential does not permit this operation');
    }
    if (a.workspace_id && !all && !principal.workspaces.includes(a.workspace_id)) {
      fail(403, 'forbidden', 'This credential does not permit this workspace');
    }
    // BEGIN IMMEDIATE makes revision checks and their writes atomic even during
    // an overlapping deployment using the same local SQLite volume.
    this.db.exec(spec.read ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = this.run(command, a, principal);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
        fail(409, 'path_conflict', 'A document already exists at this path');
      }
      throw error;
    }
  }
  run(command, a, principal) {
    const now = new Date().toISOString();
    const workspaceId = a.workspace_id;
    const touch = () => this.db.prepare('UPDATE workspaces SET revision=revision+1, updated_at=? WHERE id=?').run(now, workspaceId);
    const metadata = 'id, workspace_id, path, revision, created_at, updated_at';
    const paginated = rows => ({ items: rows.slice(0, a.limit), next_offset: rows.length > a.limit ? a.offset + a.limit : null });
    if (command === 'list_workspaces') {
      // Filter permissions in SQL before applying pagination (and before returning names).
      const scopes = principal.workspaces;
      const where = scopes.includes('*') ? '' : ` WHERE id IN (${scopes.map(() => '?').join(',') || 'NULL'})`;
      const args = scopes.includes('*') ? [] : scopes;
      const rows = this.db.prepare(`SELECT * FROM workspaces${where} ORDER BY created_at, id LIMIT ? OFFSET ?`)
        .all(...args, a.limit + 1, a.offset).map(row => ({ ...row, settings: JSON.parse(row.settings) }));
      return { ...paginated(rows), permissions: { role: principal.role, workspaces: principal.workspaces } };
    }
    if (command === 'create_workspace') {
      const uuid = randomUUID();
      this.db.prepare('INSERT INTO workspaces(id,name,settings,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(uuid, a.name, JSON.stringify(a.settings), now, now);
      return this.workspace(uuid);
    }
    const workspace = this.workspace(workspaceId);
    switch (command) {
      case 'get_workspace': return workspace;
      case 'update_workspace':
        this.checkRevision(workspace.revision, a.expected_revision);
        this.db.prepare('UPDATE workspaces SET name=?,settings=?,revision=revision+1,updated_at=? WHERE id=?')
          .run(a.name ?? workspace.name, JSON.stringify(a.settings ?? workspace.settings), now, workspaceId);
        return this.workspace(workspaceId);
      case 'delete_workspace':
        this.checkRevision(workspace.revision, a.expected_revision);
        this.db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
        return { deleted: true };
      case 'list_documents':
        return paginated(this.db.prepare(`SELECT ${metadata} FROM documents WHERE workspace_id=? ORDER BY path LIMIT ? OFFSET ?`)
          .all(workspaceId, a.limit + 1, a.offset));
      case 'search_documents': {
        const rows = this.db.prepare(`SELECT ${metadata}, substr(content,1,500) AS excerpt FROM documents
          WHERE workspace_id=? AND (instr(lower(path),lower(?))>0 OR instr(lower(content),lower(?))>0)
          ORDER BY path LIMIT ? OFFSET ?`).all(workspaceId, a.query, a.query, a.limit + 1, a.offset);
        return paginated(rows);
      }
      case 'read_document': return this.document(workspaceId, a.document_id);
      case 'create_document': {
        const uuid = randomUUID();
        this.db.prepare('INSERT INTO documents(id,workspace_id,path,content,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run(uuid, workspaceId, a.path, a.content, now, now);
        touch();
        return this.document(workspaceId, uuid);
      }
      case 'update_document': {
        const doc = this.document(workspaceId, a.document_id);
        this.checkRevision(doc.revision, a.expected_revision);
        this.db.prepare('UPDATE documents SET path=?,content=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND id=?')
          .run(a.path ?? doc.path, a.content, now, workspaceId, a.document_id);
        touch();
        return this.document(workspaceId, a.document_id);
      }
      case 'delete_document': {
        const doc = this.document(workspaceId, a.document_id);
        this.checkRevision(doc.revision, a.expected_revision);
        this.db.prepare('DELETE FROM documents WHERE workspace_id=? AND id=?').run(workspaceId, a.document_id);
        touch();
        return { deleted: true };
      }
    }
  }
}
