# syntax=docker/dockerfile:1.7

# ── Stage 1: install deps with build toolchain ──────────────────────
FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
# Reproducible install; falls back to npm install only if no lockfile present.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ── Stage 2: minimal runtime ────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

# Only ship runtime artifacts, no compilers in the final image.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY src ./src

# Writable state lives only here; the rest of /app stays root-owned and
# read-only for the runtime user. Fresh named volumes inherit this ownership.
RUN mkdir -p /app/data /app/auth_info && chown -R node:node /app/data /app/auth_info

ENV MCP_PORT=3010
ENV WHATSAPP_MCP_DATA_DIR=/app/data
ENV WHATSAPP_AUTH_DIR=/app/auth_info
ENV LOG_LEVEL=info
# MCP_AUTH_TOKEN intentionally unset — must be provided at runtime.

EXPOSE 3010

# Drop root: `node` is the unprivileged user (UID 1000) shipped with the base
# image. Bind mounts on the host must be owned by UID 1000 — main.ts verifies
# this at startup and fails fast with instructions otherwise.
USER node

# Node 24+: node:sqlite is stable, type-stripping is on by default for .ts entry.
CMD ["node", "src/main.ts"]
