# WhatsApp MCP Server (Docker Edition)

A WhatsApp MCP (Model Context Protocol) server that runs as a Docker container and is accessible over HTTP/SSE. Based on [whatsapp-mcp-ts](https://github.com/jlucaso1/whatsapp-mcp-ts) with the transport layer changed from stdio to SSE for remote access.

## Features

- **9 MCP Tools**: `search_contacts`, `list_messages`, `list_recent_messages`, `list_chats`, `get_chat`, `get_message_context`, `send_message`, `edit_message`, `search_messages`
- **Admin Web UI (Port 3011)**: Built-in token manager, audit log viewer, global send kill-switch, and local QR code pairing
- **Scoped Multi-Token Auth**: Per-agent Bearer tokens (`wamcp_…`) with 1-click presets, tool filtering (`tools/list`), chat allowlists, expiry (TTL), and per-token rate/send caps
- **Backwards-Compatible Migration**: Optional legacy `MCP_AUTH_TOKEN` continues working until disabled in the UI or env
- **Docker-first**: Runs as a non-root container (`node`, UID 1000), accessible via LAN IP
- **Streamable HTTP Transport**: Stateless MCP over HTTP POST (`/sse`)
- **Persistent Data**: SQLite DB (WAL + FTS5 search + tokens/audit) and WhatsApp auth in Docker volumes
- **Health Check**: `/health` returns 503 when WhatsApp is disconnected
- **Multi-Arch**: Builds for both amd64 and arm64

## Quick Start

### 1. Configure secrets

```bash
cp .env.example .env
# Generate an Admin UI password and write it to .env:
echo "MCP_ADMIN_PASSWORD=$(openssl rand -base64 24)" >> .env
# Optional: keep a legacy full-access token for existing clients:
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
```

### 2. Pull and Run

```bash
# Pull the image
docker pull ghcr.io/YOUR-USERNAME/whatsapp-mcp-docker:latest

# Run with docker compose
docker compose up -d

# Watch logs (or open the Admin UI on port 3011)
docker logs -f whatsapp-mcp
```

### 3. Scan QR Code & Create Scoped Agent Tokens

1. Open the Admin Web UI in your browser: `http://<YOUR-SERVER-IP>:3011/`
2. Log in with `MCP_ADMIN_PASSWORD`.
3. If WhatsApp is not yet linked, scan the locally rendered QR code directly in the Admin UI (or from `docker logs whatsapp-mcp`) via WhatsApp (`Settings → Linked Devices → Link a Device`).
4. Click **"+ Neuer Agent-Token"**, pick a preset (e.g. *Read-Only*, *Read + Send (Ausgewählte Chats)*) and optional expiration, then copy the generated config snippet for your client.

### 4. Configure MCP Client

This server speaks **Streamable HTTP** MCP (POST `/sse`), not legacy SSE. The exact config key depends on your client:

**Gemini CLI** (`~/.gemini/settings.json` — the key is `httpUrl`, **not** `url`):

```json
{
  "mcpServers": {
    "whatsapp": {
      "httpUrl": "http://192.168.0.101:3010/sse",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_FROM_DOTENV"
      }
    }
  }
}
```

> ⚠️ **Common pitfall:** Using `"url"` in Gemini CLI selects the *legacy SSE* transport, which this server does not implement. You will get 401 errors that look like an auth problem but are actually a transport mismatch. Use `"httpUrl"`.

**Claude Desktop / Cline / Continue / Cursor** (most use `url` for Streamable HTTP):

```json
{
  "mcpServers": {
    "whatsapp": {
      "url": "http://192.168.0.101:3010/sse",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_FROM_DOTENV"
      }
    }
  }
}
```

## Contact Name Resolution

WhatsApp Web (Baileys) does not give us your phone-side address book directly. To still show *your* saved names — not the contact's self-chosen push names — the server uses three layers, in this order:

1. **Manual override** (`contact_overrides.json`, see below) — wins everything.
2. **Auto-linking** — every incoming message's `pushName` is captured and stored as the `notify` of the corresponding `@s.whatsapp.net` contact. This lets the existing fuzzy-match in queries automatically connect the `@lid` form (used in groups & status updates) to the `@s.whatsapp.net` row that holds your saved address-book name. After enough message activity, most contacts resolve themselves.
3. **Fallback** — `name` → `notify` → phone digits → JID.

### Manual overrides (`contact_overrides.json`)

Use this **only** for contacts that auto-linking can't fix (e.g. a contact who has never written you directly, or whose push name and saved name are completely different and the fuzzy match doesn't catch it).

Path: `<data dir>/contact_overrides.json` (typically `/opt/docker/whatsapp-mcp/data/contact_overrides.json` on the host)

```json
{
  "210444891463794@lid": "Tammy",
  "11390320418995@lid": "Amelie",
  "4917697335710@s.whatsapp.net": "Tammy"
}
```

- The override wins over the DB-resolved name in every MCP response (`chat_name`, `sender_name`, `last_sender_name`).
- File is **hot-reloaded** on save — no container restart required.
- Each entry is a JID → display name mapping. Find a contact's JID via `search_contacts` or `list_chats`.
- See `contact_overrides.example.json` in the repo for the format.

## Security

- **The container runs as the unprivileged `node` user (UID 1000)**, not root. Everything it writes (`/app/data`, `/app/auth_info`) must be *owned* by UID 1000 — the server refuses to start otherwise and prints the exact path that is not writable.
  - *Fresh* named volumes (default `docker-compose.yml`) inherit the ownership from the image automatically.
  - **Bind mounts** (e.g. the Portainer stack) need a one-time owner change on the host. Change the owner only — the group (and any setgid/shared-group scheme you may use under `/opt/docker`) stays as it is:

    ```bash
    sudo chown -R 1000 /opt/docker/whatsapp-mcp/data /opt/docker/whatsapp-mcp/auth_info
    ```

    If your host user already has UID 1000, this simply makes the data yours (e.g. `contact_overrides.json` becomes editable without `sudo`). If the container must run as a different UID, set `user: "<uid>:<gid>"` in the compose file instead — the startup check only cares about writability, not the specific UID.

  - **Upgrading from an older (root-based) image** with *existing* data: fix ownership **before** pulling the new image, otherwise the container crash-loops on start (your session stays intact, it just cannot be written). Bind mounts: command above. Named volumes:

    ```bash
    docker compose down
    docker run --rm -v whatsapp-mcp-docker_whatsapp_data:/d -v whatsapp-mcp-docker_whatsapp_auth:/a alpine chown -R 1000 /d /a
    docker compose pull && docker compose up -d
    ```

    (Volume names are `<project>_whatsapp_data` / `<project>_whatsapp_auth`; check with `docker volume ls`.)
- **Fail-closed MCP Auth (`/sse`)**: `/sse` always requires a valid Bearer token (`401` otherwise). Tokens created in the Admin UI are stored as SHA-256 hashes only (never plaintext) and verified with `crypto.timingSafeEqual`.
- **Admin UI separation (Port `3011`)**: Protected by `MCP_ADMIN_PASSWORD` (`HttpOnly; SameSite=Strict` HMAC cookie, brute-force login rate-limit, CSRF check). If `MCP_ADMIN_PASSWORD` is unset, the Admin UI API stays disabled (`503`). You can restrict port `3011` in Docker/firewall to your management host (`127.0.0.1:3011:3011` or admin subnet) while exposing port `3010` to your local AI agents.
- **Scoped Least-Privilege & Prompt-Injection Defense**: Prefer `Read-Only` or chat-restricted tokens with short TTLs for autonomous agents. The Admin UI also provides a 1-click **Send-Kill-Switch** that immediately blocks all `send_message` / `edit_message` calls across every token.
- **Local QR Pairing & SSRF Hardening**: Pairing QR codes are rendered locally as SVG in the Admin UI and Unicode in stdout (never sent to external URLs like `quickchart.io`), and `generateHighQualityLinkPreview` is disabled.
- **Legacy Token Migration**: Existing `MCP_AUTH_TOKEN` clients continue working out of the box with full access until you disable the legacy token via the Admin UI or `MCP_DISABLE_LEGACY_TOKEN=true`.
- **TLS Note**: Over a trusted LAN, direct HTTP (`http://<LAN-IP>:3010`) is typically used; for anything untrusted or internet-facing, terminate TLS via a reverse proxy (and configure `TRUST_PROXY` if needed).
- **Sensitive Storage**: Logs in `/app/data/wa-logs.txt` and `/app/data/mcp-logs.txt` and `whatsapp.db` contain message metadata and audit records. Treat `/app/data` and `/app/auth_info` as sensitive.

## Endpoints

| Port | Endpoint | Method | Auth | Description |
|------|----------|--------|------|-------------|
| `3010` | `/sse` | POST | Bearer Token | Streamable HTTP endpoint for MCP (stateless) |
| `3010` | `/health` | GET | none | 200 when WhatsApp connected, 503 otherwise |
| `3011` | `/` | GET | Admin Cookie (UI) | Admin Web UI (Token Manager, Audit Log, QR Pairing) |
| `3011` | `/api/*` | GET/POST/PATCH/DELETE | Admin Cookie + CSRF | Admin API (`503` when `MCP_ADMIN_PASSWORD` unset) |

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_contacts` | Search contacts by name or phone number |
| `list_messages` | Get message history for a chat (paginated, max 200) |
| `list_chats` | List chats sorted by activity or name (max 100) |
| `get_chat` | Get details of a specific chat |
| `get_message_context` | Get messages around a specific message (max 50 before/after) |
| `list_recent_messages` | Cross-chat time-window query (e.g. "last 8 hours", max 500) |
| `send_message` | Send a text message to a user or group (max 4096 chars) |
| `edit_message` | Edit one of your own previously sent messages (max 4096 chars) |
| `search_messages` | Full-text search across messages (max 100) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PORT` | `3010` | HTTP port for `/sse` and `/health` |
| `MCP_ADMIN_PORT` | `3011` | HTTP port for the Admin Web UI (`0` or `disabled` turns it off) |
| `MCP_ADMIN_BIND` | `0.0.0.0` | Bind address for Admin Web UI |
| `MCP_ADMIN_PASSWORD` | _(unset)_ | Password protecting the Admin Web UI (required to enable Admin API) |
| `MCP_AUTH_TOKEN` | _(unset)_ | Optional legacy full-access Bearer token on `/sse` |
| `MCP_DISABLE_LEGACY_TOKEN` | `false` | Set `true` to ignore `MCP_AUTH_TOKEN` even if defined |
| `MCP_RATE_LIMIT_PER_MIN` | `120` | Per-IP rate limit on `/sse` (requests/minute) |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | Emergency opt-in for unauthenticated `/sse` only when zero tokens exist |
| `TRUST_PROXY` | _(unset)_ | Express `trust proxy` setting (leave unset for direct LAN HTTP) |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `WHATSAPP_MCP_DATA_DIR` | `/app/data` | SQLite database and logs directory |
| `WHATSAPP_AUTH_DIR` | `/app/auth_info` | WhatsApp auth credentials directory |
| `TZ` | `Europe/Berlin` | Timezone used for human-readable timestamps |
| `WHATSAPP_DEBUG` | _(unset)_ | If `true`, prints @lid mapping diagnostics on startup |

## Development

Requires **Node.js >= 24** (stable `node:sqlite` and on-by-default TypeScript stripping). On Node 22/23, run with `--experimental-sqlite --experimental-strip-types`.

```bash
# Install dependencies
npm install

# Run locally (Node 24+)
node src/main.ts

# Run locally (Node 22/23)
node --experimental-sqlite --experimental-strip-types src/main.ts

# Type-check only
npx tsc --noEmit

# Run tests
npm test

# Build Docker image locally
docker build -t whatsapp-mcp-docker .
```

### Dependency notes

- `@whiskeysockets/baileys` 6.x pulls `libsignal` from git, which pins a `protobufjs` 6.x with critical advisories. `package.json` `overrides` lifts it to the patched 7.x runtime. `test/libsignalRoundtrip.test.ts` performs a full Signal handshake + encrypt/decrypt through that override so a breaking protobufjs change fails in CI instead of surfacing as `Bad MAC` in production.
- Run `npm audit` after any dependency change; the Docker image is built with `npm ci` from the committed lockfile, so a rebuild alone never picks up dependency fixes.

## Architecture

```
AI Client (Gemini CLI, Claude, etc.)         Browser (Admin)
    │ HTTP POST (Streamable + Bearer)            │ HTTP + Session Cookie
    ▼                                            ▼
┌─────────────────────┐                    ┌─────────────────────┐
│  MCP Express App    │  Port 3010         │  Admin Express App  │  Port 3011
│  ├── POST /sse      │  Scoped MCP        │  ├── GET /          │  Web UI
│  └── GET /health    │  Health check      │  └── /api/*         │  Tokens/Audit/QR
├─────────────────────┴────────────────────┴─────────────────────┤
│  AuthZ & Audit (SHA-256 Tokens, Chat Allowlists, Kill-Switch)  │
├────────────────────────────────────────────────────────────────┤
│  MCP Server (9 Tools)     │  Baileys (WhatsApp Web, Reconnect) │
├────────────────────────────────────────────────────────────────┤
│  SQLite (Messages, Contacts, api_tokens, audit_logs, settings) │
└────────────────────────────────────────────────────────────────┘
```

## Credits

Based on [whatsapp-mcp-ts](https://github.com/jlucaso1/whatsapp-mcp-ts) by jlucaso1.
