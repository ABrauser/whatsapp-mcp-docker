import pino from "pino";
import { initializeDatabase, closeDatabase } from "./database.ts";
import { startWhatsAppConnection, stopWhatsAppConnection, type WhatsAppSocket } from "./whatsapp.ts";
import { startMcpServer } from "./mcp.ts";
import { type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const port = parseInt(process.env.MCP_PORT || "3010", 10);
const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";

const waLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/wa-logs.txt`)
);

const mcpLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/mcp-logs.txt`)
);

let whatsappSocket: WhatsAppSocket | null = null;
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

    mcpLogger.info("Attempting to connect to WhatsApp...");
    console.log("⏳ Connecting to WhatsApp...");
    whatsappSocket = await startWhatsAppConnection(waLogger);
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
    const result = await startMcpServer(whatsappSocket, mcpLogger, waLogger, port);
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

async function shutdown(signal: string) {
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);
  console.log(`\n🛑 Received ${signal}. Shutting down...`);

  if (httpServer) {
    mcpLogger.info("Closing HTTP server...");
    httpServer.close();
  }

  if (mcpServer) {
    mcpLogger.info("Closing MCP server...");
    try {
      await mcpServer.close();
    } catch (err: any) {
      mcpLogger.error(`Error closing MCP server: ${err.message}`);
    }
  }

  if (whatsappSocket) {
    mcpLogger.info("Closing WhatsApp connection...");
    stopWhatsAppConnection(whatsappSocket);
  }

  mcpLogger.info("Closing database...");
  closeDatabase();

  waLogger.flush();
  mcpLogger.flush();

  mcpLogger.info("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  mcpLogger.fatal({ err: error }, "Unhandled error during application startup");
  waLogger.flush();
  mcpLogger.flush();
  process.exit(1);
});
