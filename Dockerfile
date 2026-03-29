FROM node:23-alpine

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev 2>/dev/null || npm install

# Remove build dependencies to reduce image size
RUN apk del python3 make g++

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Create directories for persistent data
RUN mkdir -p /app/data /app/auth_info

# Environment variables
ENV MCP_PORT=3010
ENV WHATSAPP_MCP_DATA_DIR=/app/data
ENV WHATSAPP_AUTH_DIR=/app/auth_info
ENV LOG_LEVEL=info

# Expose MCP SSE port
EXPOSE 3010

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO /dev/null http://localhost:3010/health || exit 1

# Run the server
CMD ["node", "src/main.ts"]
