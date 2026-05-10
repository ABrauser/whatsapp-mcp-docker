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

RUN mkdir -p /app/data /app/auth_info

ENV MCP_PORT=3010
ENV WHATSAPP_MCP_DATA_DIR=/app/data
ENV WHATSAPP_AUTH_DIR=/app/auth_info
ENV LOG_LEVEL=info
# MCP_AUTH_TOKEN intentionally unset — must be provided at runtime.

EXPOSE 3010

# Node 24+: node:sqlite is stable, type-stripping is on by default for .ts entry.
CMD ["node", "src/main.ts"]
