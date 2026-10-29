# Docker Deployment for the Markdown Viewer Web App

Markdown Viewer's Docker image serves the browser-based Markdown editor and viewer as a static web app with Nginx. It is useful for local networks, self-hosting, and reverse-proxy deployments.

## Quick Start

```bash
docker run -d \
  --name markdown-viewer \
  -p 8080:80 \
  --restart unless-stopped \
  ghcr.io/thisis-developer/markdown-viewer:latest
```

Open `http://localhost:8080`.

## Docker Compose

The repository includes:

```yaml
services:
  markdown-viewer:
    build: .
    expose:
      - "80"
```

This snippet shows the frontend service; the full Compose file also starts `workspace-api` with a persistent SQLite volume. The default configuration is for Coolify or another reverse proxy on the Docker network. It publishes no host ports and does not reserve a fixed container name. Assign the domain to `markdown-viewer`, target port **80**; do not expose the API service separately.

**Before starting**, set runtime `WORKSPACE_PUBLIC_ORIGIN` and secret `WORKSPACE_TOKENS_JSON` as described in [Server Workspaces](Server-Workspaces.md#required-runtime-configuration). This is required for the Compose deployment. The static image can still run alone without these settings for browser-local use.

Run behind your proxy:

```bash
docker compose up -d
```

Rebuild after local source changes:

```bash
docker compose up -d --build
```

For standalone local access without a proxy, explicitly add the local override:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

For this local override set `WORKSPACE_PUBLIC_ORIGIN=http://localhost:8080` and provide the token configuration first. Open `http://localhost:8080`. The override binds loopback only; it is not used by Coolify. If port 8080 is occupied, use `MARKDOWN_VIEWER_PORT=8081` together with `WORKSPACE_PUBLIC_ORIGIN=http://localhost:8081`.

Stop using the same files you started with:

```bash
# Proxy deployment
docker compose down
# Standalone local deployment
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

## Building Locally

```bash
docker build -t markdown-viewer:local .
docker run -d --name markdown-viewer-local -p 8080:80 markdown-viewer:local
```

The root `.dockerignore` excludes desktop build output and unrelated local files from the web container, while retaining runtime Markdown assets. The publishing workflow targets `linux/amd64` and `linux/arm64`; a local build uses the Docker host's architecture.

Validate packaging, MIME types, caching, and missing-route responses against a real container:

```bash
npm run test:docker
```

This requires a running Docker daemon but no locally installed npm dependencies. The check builds the web and API images, verifies static assets, API authentication, MCP initialization, and named-volume persistence across API container recreation, then cleans up its temporary images, containers, network, and volume.

## What the Container Provides

The container serves the static browser shell: `index.html`, `workspace-storage.js`, `script.js`, `styles.css`, `sw.js`, `manifest.json`, `robots.txt`, `sitemap.xml`, and `assets/`. It provides the Editor, main-thread Preview, local storage, local imports, most exports, and CDN-loaded renderer libraries.

On `localhost`, managed-media and stored Share Snapshot requests use the production `https://markdownviewer.pages.dev` API. Live Share defaults to the Docker origin and fails unless a compatible `/live-room` endpoint is available or `window.MARKDOWN_VIEWER_LIVE_ROOM_URL` is configured in a custom deployment.

The container alone does not provide Cloudflare KV or Durable Objects. Self-hosted stored Share Snapshot and Live Share require separately deployed compatible endpoints.

## Runtime Packaging and Optional Services

The image includes every critical Service Worker asset, including `preview-worker.js` and `sample.md`, plus the `native-markdown-source.js` script referenced by the page. JavaScript modules have an explicit JavaScript MIME type, and Markdown assets are served as plain text. Missing files return `404` rather than successful application HTML.

Nginx proxies `/api/workspaces`, `/api/workspaces/*`, and `/mcp` to the Compose API service. Other `/api` routes and `/live-room` routes return `404`. Stored snapshots, managed-media uploads, and Live Share are **not available from this container alone**. Small URL-embedded snapshots do not require server storage. On LAN hostnames, API requests target the LAN origin, not the production API. Using the production API from a custom origin also requires compatible CORS/origin policy; changing a URL alone is not sufficient.

## Nginx and Headers

The Docker image uses `nginx:alpine`. Production deployments should keep these behaviors:

- Serve `index.html`, `workspace-storage.js`, `script.js`, `styles.css`, `preview-worker.js`, `sw.js`, `manifest.json`, and `assets/`.
- Serve `sample.md` because the Service Worker includes it in the critical precache.
- Serve JavaScript files with correct MIME types.
- Allow Service Worker registration from the app origin.
- Send security headers that match the app's CSP and deployment policy. The current Docker image includes:

```nginx
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

`nginx.conf` sets a Content-Security-Policy aligned with the HTML meta policy, including `esm.sh`, media hosts, and the production sharing origins. Both policies are enforced by browsers, so update both when adding a renderer or changing lazy-loaded resources. Allowing an origin in CSP does not provision a sharing backend or grant CORS access.

Cloudflare Pages deployments use the stricter root `_headers` and `_redirects` files, including CSP, HSTS, clickjacking, permissions, cross-origin, and sensitive-path protections. When self-hosting behind Docker or another reverse proxy, keep the CSP compatible with `index.html`, lazy-loaded renderers, Share Snapshot, and Live Share instead of copying a wildcard policy.

Static responses use `Cache-Control: no-cache`: browsers may retain assets but must revalidate before reusing them online. Authenticated workspace API and MCP responses additionally use `no-store` and bypass Service Worker caching. The app uses unversioned filenames, so long-lived immutable caching is unsafe. The Service Worker can still use cached assets when offline. Keep reverse-proxy cache rules consistent with these response headers.

## Coolify on a Mac Mini / LAN

Coolify targets Linux, not native macOS. If the Mac mini runs macOS, use a supported Linux VM with Docker and Coolify, with networking that makes the proxy reachable from your LAN. On Apple Silicon, use an ARM64 Linux guest and build from source or use a published ARM64 image.

1. For shared server workspaces and MCP, use the **Docker Compose** build pack with `/docker-compose.yml` and configure the required runtime origin/tokens (see [Server Workspaces](Server-Workspaces.md)). For a browser-local-only app, the **Dockerfile** build pack with `/Dockerfile` remains supported.
2. Set the application port to **80**. If configuring a health check, use HTTP `GET /` on port 80.
3. Assign a dedicated root hostname, such as `markdown.home.example.com`, resolving to the Coolify host's LAN address. Replace this example with a domain you control.
4. Terminate **trusted HTTPS** at Coolify's proxy. Use a DNS-validated certificate for your domain or a private CA trusted by every client device. A private-CA certificate without client trust is not sufficient. HTTP on a LAN IP is not a browser secure context; PWA/service workers, encrypted workspaces, and some clipboard features require HTTPS.
5. Do not expose a separate public application port or forward router ports unless you intend external access. If using Coolify's **Docker Compose** build pack instead, use only `/docker-compose.yml`, assign the domain to the `markdown-viewer` service, and target port **80**. Do not include `docker-compose.local.yml`; that override is only for direct local access. If you previously edited Compose in Coolify, reload the configuration from the repository so an old `8080:80` mapping is not retained.

The Compose deployment requires runtime origin/token configuration and persists server workspaces in the `workspace-data` volume on the host. The browser's original local workspace still lives in IndexedDB and does not sync automatically. Browser ZIP exports back up local documents only; back up the server volume separately. Keep the hostname, scheme, and port stable because local browser storage is origin-specific. See [Server Workspaces](Server-Workspaces.md) for token scoping, REST/MCP, revision conflicts, backups, and current limitations.

Self-hosting still uses CDN dependencies and some external diagram services. It is not an air-gapped deployment. See the privacy notes below.

## Reverse Proxy Examples

Nginx:

```nginx
server {
    listen 443 ssl;
    server_name markdown.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Caddy:

```caddyfile
markdown.example.com {
    reverse_proxy localhost:8080
}
```

Traefik labels:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.mdviewer.rule=Host(`markdown.example.com`)"
  - "traefik.http.routers.mdviewer.entrypoints=websecure"
  - "traefik.http.routers.mdviewer.tls.certresolver=letsencrypt"
  - "traefik.http.services.mdviewer.loadbalancer.server.port=80"
```

## Custom Sub-Paths

Serving from a sub-path such as `/editor/` requires testing:

- Worker URL resolution for `preview-worker.js`.
- Service Worker scope.
- Manifest path.
- Asset paths in `index.html`.
- Dynamic library loading in `script.js`.
- Share and Live Share public base URL behavior.

Root hosting is the simplest and best-tested deployment mode.

## Privacy Notes for Self-Hosting

- Normal documents stay in the user's browser storage.
- Your server will serve static assets and may log normal HTTP requests.
- URL-hash Share Snapshot content is not sent to the server as an HTTP fragment, but users can paste links into other systems.
- Stored Share Snapshot and Live Share need Cloudflare or compatible services and have their own data flows.
- The stock localhost client sends consented managed-media and stored Share Snapshot requests to the production Markdown Viewer API.

For the complete boundary, see [Privacy and Security](Privacy-and-Security.md). For diagnostics, see [Troubleshooting](Troubleshooting.md#docker-preview-or-pwa-offline-support-is-incomplete).
