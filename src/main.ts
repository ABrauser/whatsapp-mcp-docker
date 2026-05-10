import pino from "pino";
import roll from "pino-roll";
import fs from "node:fs";
import { initializeDatabase, closeDatabase } from "./database.ts";
import { startWhatsAppConnection, stopWhatsAppConnection, type WhatsAppConnection } from "./whatsapp.ts";
import { startMcpServer } from "./mcp.ts";
import { initContactOverrides, closeContactOverrides } from "./contactOverrides.ts";
import { type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const port = Number.parseInt(process.env.MCP_PORT || "3010", 10);
if (!Number.isFinite(port) || port < 1 || port > 65535) {
  console.error(`❌ Invalid MCP_PORT: "${process.env.MCP_PORT}"`);
  process.exit(1);
}
const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";
fs.mkdirSync(dataDir, { recursive: true });

// Rotated log files: 10 MB max per chunk, daily new file, retain 7 days.
// Falls back to a plain destination if pino-roll fails (e.g. read-only FS).
async function buildRotatingLogger(
  baseFile: string,
): Promise<pino.Logger> {
  const opts: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  try {
    const stream = await roll({
      file: baseFile,
      size: "10m",
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      limit: { count: 7 },
      mkdir: true,
    });
    return pino(opts, stream);
  } catch (err) {
    console.warn(
      `pino-roll setup failed for ${baseFile}, falling back to plain destination:`,
      err,
    );
    return pino(opts, pino.destination(baseFile));
  }
}

const waLogger = await buildRotatingLogger(`${dataDir}/wa-logs.txt`);
const mcpLogger = await buildRotatingLogger(`${dataDir}/mcp-logs.txt`);

let whatsappConnection: WhatsAppConnection | null = null;
let httpServer: Server | null = null;
let mcpServer: McpServer | null = null;

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       WhatsApp MCP Server (Docker Edition)          ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  mcpLogger.info("Starting WhatsApp MCP Server...");

  try {
    mcpLogger.info("Initializing database...");
    initializeDatabase();
    mcpLogger.info("Database initialized successfully.");
    console.log("✅ Database initialized");

    initContactOverrides(dataDir);

    mcpLogger.info("Attempting to connect to WhatsApp...");
    console.log("⏳ Connecting to WhatsApp...");
    whatsappConnection = await startWhatsAppConnection(waLogger, undefined, () => shutdown("LOGGED_OUT"));
    mcpLogger.info("WhatsApp connection process initiated.");
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during initialization or WhatsApp connection attempt"
    );
    console.error("❌ Fatal error during startup:", error.message);
    process.exit(1);
  }

  try {
    mcpLogger.info("Starting MCP server...");
    const result = await startMcpServer(whatsappConnection, mcpLogger, waLogger, port);
    httpServer = result.httpServer;
    mcpServer = result.mcpServer;
    mcpLogger.info("MCP Server started and listening.");
  } catch (error: any) {
    mcpLogger.fatal({ err: error }, "Failed to start MCP server");
    console.error("❌ Failed to start MCP server:", error.message);
    process.exit(1);
  }

  mcpLogger.info("Application setup complete. Running...");
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);
  console.log(`\n🛑 Received ${signal}. Shutting down...`);

  if (httpServer) {
    const srv = httpServer;
    mcpLogger.info("Closing HTTP server...");
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }

  if (mcpServer) {
    mcpLogger.info("Closing MCP server...");
    try {
      await mcpServer.close();
    } catch (err: any) {
      mcpLogger.error(`Error closing MCP server: ${err.message}`);
    }
  }

  if (whatsappConnection) {
    mcpLogger.info("Closing WhatsApp connection...");
    stopWhatsAppConnection(whatsappConnection);
  }

  mcpLogger.info("Closing contact overrides watcher...");
  closeContactOverrides();

  mcpLogger.info("Closing database...");
  closeDatabase();

  waLogger.flush();
  mcpLogger.flush();

  mcpLogger.info("Shutdown complete.");
  process.exit(signal === "LOGGED_OUT" ? 1 : 0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  mcpLogger.fatal({ err: error }, "Unhandled error during application startup");
  waLogger.flush();
  mcpLogger.flush();
  process.exit(1);
});
