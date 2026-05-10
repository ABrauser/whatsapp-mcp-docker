# WhatsApp MCP Server (Docker Edition)

A WhatsApp MCP (Model Context Protocol) server that runs as a Docker container and is accessible over HTTP/SSE. Based on [whatsapp-mcp-ts](https://github.com/jlucaso1/whatsapp-mcp-ts) with the transport layer changed from stdio to SSE for remote access.

## Features

- **8 MCP Tools**: search_contacts, list_messages, list_recent_messages, list_chats, get_chat, get_message_context, send_message, search_messages
- **Docker-first**: Runs as a container, accessible via IP
- **Streamable HTTP Transport**: stateless MCP over HTTP POST
- **Bearer-token auth** for `/sse` (set `MCP_AUTH_TOKEN`)
- **Persistent Data**: SQLite DB (WAL + FTS5 search) and WhatsApp auth in Docker volumes
- **Health Check**: `/health` returns 503 when WhatsApp is disconnected
- **Multi-Arch**: Builds for both amd64 and arm64

## Quick Start

### 1. Configure secrets

```bash
cp .env.example .env
# Generate a strong token and write it to .env:
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
```

### 2. Pull and Run

```bash
# Pull the image
docker pull ghcr.io/YOUR-USERNAME/whatsapp-mcp-docker:latest

# Run with docker compose
docker compose up -d

# Watch logs for QR code
docker logs -f whatsapp-mcp
```

### 3. Scan QR Code

On first start, a QR code URL will appear in the logs. Open it in your browser and scan with WhatsApp (Settings → Linked Devices → Link a Device).

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

## Contact Name Overrides

WhatsApp Web (Baileys) does not always sync your phone-side address book. If a contact appears under their *push name* (what they set themselves) instead of the name you saved on your phone, you can override the display name with a JSON file:

Path: `<data dir>/contact_overrides.json` (typically `/opt/docker/whatsapp-mcp/data/contact_overrides.json` on the host)

```json
{
  "210444891463794@lid": "Tammy",
  "11390320418995@lid": "Amelie",
  "4917697335710@s.whatsapp.net": "Tammy"
}
```

- The override wins over both `name` and `notify` from the DB in every MCP response (`chat_name`, `sender_name`, `sender_display`, `last_sender_*`).
- File is **hot-reloaded** on save — no container restart required.
- Each entry is a JID → display name mapping. Find a contact's JID via `search_contacts` or `list_chats`.
- See `contact_overrides.example.json` in the repo for the format.

## Security

- **Always set `MCP_AUTH_TOKEN`** unless you bind the container to `127.0.0.1` only. Without a token, anyone on your network can read your chats and send messages from your account.
- Without TLS, the token is sent in plaintext. For LAN-only deployments this is usually acceptable; for anything wider, terminate TLS in a reverse proxy (Caddy, Traefik, nginx).
- Logs in `/app/data/wa-logs.txt` and `/app/data/mcp-logs.txt` may contain message snippets. Treat the data volume as sensitive.
- The QR code from initial pairing is logged at `info` level once — it grants full session access for a few seconds. Don’t share that log.

## Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/sse` | POST | Bearer | Streamable HTTP endpoint for MCP (stateless) |
| `/health` | GET | none | 200 when WhatsApp connected, 503 otherwise |

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_contacts` | Search contacts by name or phone number |
| `list_messages` | Get message history for a chat (paginated) |
| `list_chats` | List chats sorted by activity or name |
| `get_chat` | Get details of a specific chat |
| `get_message_context` | Get messages around a specific message |
| `list_recent_messages` | Cross-chat time-window query (e.g. "last 8 hours") with optional ISO `since`/`until` |
| `send_message` | Send a text message to a user or group |
| `search_messages` | Full-text search across messages |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PORT` | `3010` | HTTP server port |
| `MCP_AUTH_TOKEN` | _(unset)_ | Bearer token required on `/sse`. If unset, endpoint is open. |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `WHATSAPP_MCP_DATA_DIR` | `/app/data` | SQLite database directory |
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

# Build Docker image locally
docker build -t whatsapp-mcp-docker .
```

## Architecture

```
AI Client (Gemini CLI, Claude, etc.)
    │
    │ HTTP POST (Streamable)
    ▼
┌─────────────────────┐
│  Express Server     │  Port 3010
│  ├── POST /sse      │  Stateless MCP
│  └── GET /health    │  Health check
├─────────────────────┤
│  MCP Server         │  7 Tools
├─────────────────────┤
│  Baileys            │  WhatsApp Web API (Reconnects + Backoff)
├─────────────────────┤
│  SQLite             │  Messages & Contacts (Batch Sync)
└─────────────────────┘
```

## Credits

Based on [whatsapp-mcp-ts](https://github.com/jlucaso1/whatsapp-mcp-ts) by jlucaso1.
