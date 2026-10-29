# Server Workspaces, REST API, and MCP

The self-hosted Compose deployment has an **opt-in server workspace** alongside the existing browser-local workspace. The browser, REST clients, and MCP agents use the same persisted documents and revision checks.

## Model and current scope

- **Workspace:** opaque UUID, name, scalar JSON settings, revision, and timestamps.
- **Document:** opaque UUID, workspace UUID, relative Markdown path, content, revision, and timestamps.
- **Logical folders:** represented by document paths such as `engineering/notes/start.md`; empty folders are not stored.
- **Session:** tabs, selection, view mode, and unsaved drafts belong to the browser, not the shared workspace.
- **Permissions:** configured bearer credentials grant `read`, `write`, or `admin`, scoped to workspace UUIDs or `*`.

This first version synchronizes **Markdown content/paths and workspace metadata/settings only**. Review comments, managed media/assets, Secret Workspace encryption, trash/history, and editor sessions are not synchronized. Server deletions are permanent. There is no background migration, automatic remote autosave, or real-time editing. Browser-local and server workspaces remain separate.

## Deploy on Coolify

Use the **Docker Compose** build pack and `/docker-compose.yml` from this branch. The Compose deployment includes:

- `markdown-viewer`: Nginx on container port **80**, the only service assigned a public/LAN domain.
- `workspace-api`: Node 22, SQLite, REST and Streamable HTTP MCP on internal port **3000**.
- `workspace-data`: named volume mounted at `/data` containing `workspaces.sqlite` and its WAL files.

Neither service publishes a host port. Nginx proxies `/api/workspaces`, `/api/workspaces/*`, and `/mcp` to the API over a private Docker network. Other Cloudflare sharing/media routes are not implemented by this backend.

### Required runtime configuration

In Coolify configure these **runtime** environment variables (not Docker build arguments):

- `WORKSPACE_PUBLIC_ORIGIN=https://markdown.lan.cgd-intranet.com` — exact browser origin, **no trailing slash**. Browser requests from other origins are rejected.
- `WORKSPACE_TOKENS_JSON` — a secret JSON array with one or more credential records.

Generate a fresh bootstrap administrator credential on a trusted machine:

```bash
node -e 'console.log(JSON.stringify([{token:require("node:crypto").randomBytes(32).toString("hex"),role:"admin",workspaces:["*"]}]))'
```

Store the generated JSON as the secret `WORKSPACE_TOKENS_JSON` value. The `token` string inside it is what you enter in the browser. Do not commit or share this JSON, place tokens in URLs, or put credentials in an agent's prompt. The server refuses to start without valid credentials and an origin.

Assign `https://markdown.lan.cgd-intranet.com` to **markdown-viewer**, target port **80**. Do not assign a separate domain to `workspace-api`, and do not include the local override. Reload Compose from the repository if Coolify retained an older configuration. Redeploy after updating runtime secrets.

For direct local testing, export the same two variables with `WORKSPACE_PUBLIC_ORIGIN=http://localhost:8080`, then run:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

For a different local port, set both `MARKDOWN_VIEWER_PORT` and the matching `WORKSPACE_PUBLIC_ORIGIN`. The override only binds loopback.

### Least-privilege agent credentials

Use the administrator credential to create a workspace and obtain its `id`. Generate a **different** random token for each agent/user, add it to the configured array, and redeploy:

```json
{
  "token": "<new-random-token-at-least-32-characters>",
  "role": "write",
  "workspaces": ["<workspace-uuid>"]
}
```

- `read`: list/read/search permitted workspaces and documents.
- `write`: additionally create/update/delete documents and update workspace metadata/settings.
- `admin` with `workspaces: ["*"]`: additionally create/delete whole workspaces.

Workspace scope is checked on every REST request and MCP tool call, including document reads. Credentials do not have user identities, expiry, OAuth login, or per-document ACLs. Remove/replace a credential and redeploy to revoke/rotate it; existing browser sessions will then fail subsequent API requests. A server running outside Compose can read the JSON from `WORKSPACE_TOKENS_FILE` instead of an environment variable; mount that file read-only yourself.

## Browser workflow

1. Open **Server workspaces** (bottom-right launcher).
2. Enter a token and connect. The token is kept in page memory only, not localStorage, sessionStorage, IndexedDB, a URL, or a service-worker cache.
3. Select/create a workspace and open/create a Markdown document. Server tabs are labeled `[Server]`.
4. Edit in the existing editor and save with **Save to server** or **Ctrl/Cmd+S**. The banner shows the saved revision and unsaved state. Read-only credentials open read-only documents.
5. Use **Reload from server** for a clean document to see changes made by agents or other browsers.

Each save requires the revision originally read. If another client saved first, the server returns **409** and the browser retains your draft. Copy/download it, close the tab (explicitly confirming discard), reopen the latest server version, and merge. There is deliberately no force-overwrite button. Typing while a save is in flight remains dirty after that request succeeds.

Remote drafts are **not** persisted in the local workspace or its recovery journals. Closing an unsaved server tab requires confirmation; disconnecting or replacing the local workspace is blocked while server drafts are dirty. Reloading/exiting warns about dirty server drafts, but browser crashes cannot be recovered: save or download your work. Browser private mode controls local persistence only; explicit server saves still send content to the server.

Normal browser-local documents are unchanged and are not uploaded automatically. To migrate one, create a server document and deliberately copy/paste its Markdown. Browser workspace ZIP exports do **not** include server workspaces.

## REST API

Send `Authorization: Bearer <token>` on every request, and `Content-Type: application/json` for bodies. Responses are JSON with `Cache-Control: no-store`. No cookies or wildcard CORS are used. An omitted `Origin` is permitted for authenticated CLI/agent clients; it does not bypass token checks.

| Method | Route | Body/query |
| --- | --- | --- |
| GET | `/api/workspaces` | `offset`, `limit` |
| POST | `/api/workspaces` | `{name, settings?}` |
| GET | `/api/workspaces/:workspace` | — |
| PATCH | `/api/workspaces/:workspace` | `{name?, settings?, expected_revision}` |
| DELETE | `/api/workspaces/:workspace` | `{expected_revision}` |
| GET | `/api/workspaces/:workspace/documents` | `offset`, `limit` |
| POST | `/api/workspaces/:workspace/documents` | `{path, content?}` |
| GET | `/api/workspaces/:workspace/documents/:document` | — |
| PUT | `/api/workspaces/:workspace/documents/:document` | `{content, path?, expected_revision}` |
| DELETE | `/api/workspaces/:workspace/documents/:document` | `{expected_revision}` |
| GET | `/api/workspaces/:workspace/search` | `query`, `offset`, `limit` |

List/search results contain `{items, next_offset}`; continue until `next_offset` is `null`. The workspace list also returns the current credential's `permissions`. Default page size is 100, maximum 200. Document listings omit content; search returns short excerpts. Document content is limited to 10 MiB UTF-8; JSON requests are limited to 11 MiB. Paths are case-sensitive, unique within a workspace, and must end in `.md` or `.markdown`; parent/absolute paths are rejected.

Revisions are positive integers, returned with each record (also as ETag on individual REST records). Supply `expected_revision` in update/delete bodies; ETag alone is not a write precondition. Any document mutation also advances the workspace revision so stale whole-workspace deletes cannot remove newly changed documents. Settings are a small flat JSON object with string/boolean/number/null values.

Example, with a token already set in the shell:

```bash
curl --fail-with-body https://markdown.lan.cgd-intranet.com/api/workspaces \
  -H "Authorization: Bearer $WORKSPACE_TOKEN"
```

Errors have `{error, message}`. Common statuses: 400 invalid input; 401 invalid/missing token; 403 scope/role/origin denied; 404 missing record; 409 revision/path conflict; 413 request too large. Reads never grant access based solely on a document UUID.

## MCP

Endpoint: **`https://markdown.lan.cgd-intranet.com/mcp`**

Transport: **Streamable HTTP**, stateless, JSON responses, official MCP SDK. Supply a bearer header through your MCP client's secret configuration. The endpoint does not implement OAuth discovery, legacy SSE, or browser-driven authentication. GET/DELETE on `/mcp` return 405 because there is no persistent MCP transport session; workspaces remain durable independently.

Example shape for clients supporting a remote MCP URL and custom headers (exact client syntax varies):

```json
{
  "mcpServers": {
    "markdown-workspaces": {
      "url": "https://markdown.lan.cgd-intranet.com/mcp",
      "headers": { "Authorization": "Bearer <workspace-scoped-agent-token>" }
    }
  }
}
```

Tools:

```text
list_workspaces(offset?, limit?)
get_workspace(workspace_id)
create_workspace(name, settings?)
update_workspace(workspace_id, expected_revision, name?, settings?)
delete_workspace(workspace_id, expected_revision)
list_documents(workspace_id, offset?, limit?)
read_document(workspace_id, document_id)
create_document(workspace_id, path, content?)
update_document(workspace_id, document_id, content, expected_revision, path?)
delete_document(workspace_id, document_id, expected_revision)
search_documents(workspace_id, query, offset?, limit?)
```

MCP uses the **same validation, permissions, transactions, and storage** as REST. Tool execution errors set `isError: true` with a JSON error/status in text content. Successful results include JSON text and structured content. No tool executes a shell command or accepts a filesystem root. Document text and search results are untrusted data, not instructions to the agent. Configure agent confirmation for destructive operations; the API itself does not prompt for user approval.

## Operations and security boundaries

- Use trusted HTTPS and keep the service private through DNS/firewall rules. A LAN hostname is not access control. Bearer credentials are passwords.
- Data is stored as plaintext SQLite, **not end-to-end encrypted**. Protect/encrypt the host and backups. Administrators with volume access can read content.
- Keep the same Coolify resource and named volume across redeployments. Do **not** run `docker compose down -v` unless intentionally deleting server workspaces.
- Back up the server volume separately from browser ZIP exports. For a simple consistent backup, stop `workspace-api`, copy the volume, then restart it; do not copy only a live `.sqlite` file while ignoring WAL state. Test restore to a separate deployment.
- SQLite is for a single host and a local persistent volume, not NFS or distributed multi-host replicas. Transactions make revision checks atomic; overlapping processes on that same filesystem use SQLite locking.
- No automatic retention expiry, server Trash, full-text indexing service, public sharing links, or audit log is provided in this initial version.
- Browser API/MCP responses bypass the Service Worker and are never put in offline caches. The static shell and CDN dependencies still use the app's existing caching/network behavior.
- The static Nginx image can still be run alone for browser-local use. Server workspace calls then fail because the separate API service is absent; this is not a Cloudflare Pages backend.

Checks: `npm run build`, `npm run test:unit`, `npx playwright test tests/e2e/server-workspaces.spec.js --project=chromium`, and `npm run test:docker` (requires Docker).
