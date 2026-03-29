# WhatsApp MCP Server (Docker Edition)

A WhatsApp MCP (Model Context Protocol) server that runs as a Docker container and is accessible over HTTP/SSE. Based on [whatsapp-mcp-ts](https://github.com/jlucaso1/whatsapp-mcp-ts) with the transport layer changed from stdio to SSE for remote access.

## Features

- **7 MCP Tools**: search_contacts, list_messages, list_chats, get_chat, get_message_context, send_message, search_messages
- **Docker-first**: Runs as a container, accessible via IP
- **SSE Transport**: HTTP-based MCP protocol (not stdio)
- **Persistent Data**: SQLite DB and WhatsApp auth stored in Docker volumes
- **Health Check**: Built-in `/health` endpoint
- **Multi-Arch**: Builds for both amd64 and arm64

## Quick Start

### 1. Pull and Run

```bash
# Pull the image
docker pull ghcr.io/YOUR-USERNAME/whatsapp-mcp-docker:latest

# Run with docker compose
docker compose up -d

# Watch logs for QR code
docker logs -f whatsapp-mcp
```

### 2. Scan QR Code

On first start, a QR code URL will appear in the logs. Open it in your browser and scan with WhatsApp (Settings → Linked Devices → Link a Device).

### 3. Configure MCP Client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "whatsapp": {
      "url": "http://192.168.0.101:3001/sse"
    }
  }
}
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | SSE connection for MCP clients |
| `/messages` | POST | JSON-RPC message endpoint |
| `/health` | GET | Health check |

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_contacts` | Search contacts by name or phone number |
| `list_messages` | Get message history for a chat (paginated) |
| `list_chats` | List chats sorted by activity or name |
| `get_chat` | Get details of a specific chat |
| `get_message_context` | Get messages around a specific message |
| `send_message` | Send a text message to a user or group |
| `search_messages` | Full-text search across messages |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PORT` | `3001` | HTTP server port |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `WHATSAPP_MCP_DATA_DIR` | `/app/data` | SQLite database directory |
| `WHATSAPP_AUTH_DIR` | `/app/auth_info` | WhatsApp auth credentials directory |

## Development

```bash
# Install dependencies
npm install

# Run locally
node src/main.ts

# Build Docker image locally
docker build -t whatsapp-mcp-docker .
```

## Architecture

```
AI Client (Gemini CLI, Claude, etc.)
    │
    │ HTTP SSE
    ▼
┌─────────────────────┐
│  Express Server     │  Port 3001
│  ├── GET /sse       │  SSE connection
│  ├── POST /messages │  JSON-RPC
│  └── GET /health    │  Health check
├─────────────────────┤
│  MCP Server         │  7 Tools
├─────────────────────┤
│  Baileys            │  WhatsApp Web API
├─────────────────────┤
│  SQLite             │  Messages & Contacts
└─────────────────────┘
```

## Credits

Based on [whatsapp-mcp-ts](https://github.com/jlucaso1/whatsapp-mcp-ts) by jlucaso1.
