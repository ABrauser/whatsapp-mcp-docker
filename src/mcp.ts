import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import express, { type Request, type Response } from "express";
import { type Server } from "node:http";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getChats,
  getChat,
  getMessagesAround,
  searchDbForContacts,
  searchMessages,
} from "./database.ts";

import { sendWhatsAppMessage, scheduleLazyGroupNameFetch, type WhatsAppConnection } from "./whatsapp.ts";
import type { Logger } from "pino";

const TZ = process.env.TZ || "Europe/Berlin";

function toLocalTime(date: Date): string {
  // Use sv-SE (Sweden) as a hack to get YYYY-MM-DD HH:mm:ss format
  // which is close to ISO but more readable in chat history.
  return date.toLocaleString("sv-SE", { timeZone: TZ }).replace("T", " ");
}

function formatDbMessageForJson(msg: DbMessage) {
  // is_from_me is the single source of truth for "Me"; sender JID may still be
  // set in groups but we want consistent display.
  const senderDisplay = msg.is_from_me
    ? "Me"
    : msg.sender
      ? (msg.sender_name ?? msg.sender.split("@")[0])
      : "Unknown";
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_name: msg.sender_name ?? null,
    sender_display: senderDisplay,
    content: msg.content,
    timestamp: toLocalTime(msg.timestamp),
    is_from_me: msg.is_from_me,
  };
}

function formatDbChatForJson(chat: DbChat) {
  return {
    jid: chat.jid,
    name: chat.name ?? chat.jid.split("@")[0] ?? chat.jid,
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time ? toLocalTime(chat.last_message_time) : null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    last_sender_name: chat.last_sender_name ?? null,
    last_sender_display: chat.last_sender
      ? (chat.last_sender_name ?? chat.last_sender.split("@")[0])
      : chat.last_is_from_me
        ? "Me"
        : null,
    last_is_from_me: chat.last_is_from_me ?? null,
  };
}

/**
 * Build a fresh MCP server with all tools registered. Per-request creation is
 * required for the stateless Streamable-HTTP pattern to avoid leaking listeners
 * across `transport.connect()` calls.
 */
function createMcpServer(
  connection: WhatsAppConnection | null,
  mcpLogger: Logger,
  waLogger: Logger,
): McpServer {
  const server = new McpServer({
    name: "whatsapp-mcp-docker",
    version: "1.0.0",
  });

  // ─── Tool: search_contacts ────────────────────────────────────────
  server.tool(
    "search_contacts",
    {
      query: z
        .string()
        .min(1)
        .describe("Search term for contact name or phone number part of JID"),
    },
    async ({ query }) => {
      mcpLogger.info(
        `[MCP Tool] Executing search_contacts with query: "${query}"`,
      );
      try {
        const contacts = searchDbForContacts(query, 20);
        const formattedContacts = contacts.map((c) => ({
          jid: c.jid,
          name: c.name ?? c.jid.split("@")[0],
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContacts, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_contacts failed: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching contacts: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // ─── Tool: list_messages ──────────────────────────────────────────
  server.tool(
    "list_messages",
    {
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max messages per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, limit, page }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}`,
      );
      try {
        const messages = getMessages(chat_jid, limit, page);
        if (!messages.length && page === 0) {
          return {
            content: [
              { type: "text", text: `No messages found for chat ${chat_jid}.` },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }
        const formattedMessages = messages.map(formatDbMessageForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_messages failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing messages for ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // ─── Tool: list_chats ─────────────────────────────────────────────
  server.tool(
    "list_chats",
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max chats per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
      sort_by: z
        .enum(["last_active", "name"])
        .optional()
        .default("last_active")
        .describe("Sort order: 'last_active' (default) or 'name'"),
      query: z
        .string()
        .optional()
        .describe("Optional filter by chat name or JID"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ limit, page, sort_by, query, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_chats: limit=${limit}, page=${page}, sort=${sort_by}, query=${query}, lastMsg=${include_last_message}`,
      );
      try {
        const chats = getChats(
          limit,
          page,
          sort_by,
          query ?? null,
          include_last_message,
        );
        if (!chats.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No chats found${query ? ` matching "${query}"` : ""}.`,
              },
            ],
          };
        } else if (!chats.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more chats found on page ${page}${
                  query ? ` matching "${query}"` : ""
                }.`,
              },
            ],
          };
        }
        const formattedChats = chats.map(formatDbChatForJson);
        // If any group is unnamed, kick off a lazy background refresh of group
        // metadata so the next call has nicer names. Non-blocking.
        const hasUnnamedGroup = chats.some(
          (c) => c.jid.endsWith("@g.us") && !c.name
        );
        if (hasUnnamedGroup) {
          scheduleLazyGroupNameFetch(connection, waLogger);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChats, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] list_chats failed: ${error.message}`);
        return {
          isError: true,
          content: [
            { type: "text", text: `Error listing chats: ${error.message}` },
          ],
        };
      }
    },
  );

  // ─── Tool: get_chat ───────────────────────────────────────────────
  server.tool(
    "get_chat",
    {
      chat_jid: z.string().describe("The JID of the chat to retrieve"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ chat_jid, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_chat for ${chat_jid}, lastMsg=${include_last_message}`,
      );
      try {
        const chat = getChat(chat_jid, include_last_message);
        if (!chat) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Chat with JID ${chat_jid} not found.` },
            ],
          };
        }
        const formattedChat = formatDbChatForJson(chat);
        if (chat.jid.endsWith("@g.us") && !chat.name) {
          scheduleLazyGroupNameFetch(connection, waLogger);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChat, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_chat failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // ─── Tool: get_message_context ────────────────────────────────────
  server.tool(
    "get_message_context",
    {
      message_id: z
        .string()
        .describe("The ID of the target message to get context around"),
      before: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages before (default 5)"),
      after: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages after (default 5)"),
    },
    async ({ message_id, before, after }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_message_context for msg ${message_id}, before=${before}, after=${after}`,
      );
      try {
        const context = getMessagesAround(message_id, before, after);
        if (!context.target) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Message with ID ${message_id} not found.`,
              },
            ],
          };
        }
        const formattedContext = {
          target: formatDbMessageForJson(context.target),
          before: context.before.map(formatDbMessageForJson),
          after: context.after.map(formatDbMessageForJson),
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContext, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_message_context failed for ${message_id}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving context for message ${message_id}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // ─── Tool: send_message ───────────────────────────────────────────
  server.tool(
    "send_message",
    {
      recipient: z
        .string()
        .describe(
          "Recipient JID (user or group, e.g., '12345@s.whatsapp.net' or 'group123@g.us')",
        ),
      message: z.string().min(1).describe("The text message to send"),
    },
    async ({ recipient, message }) => {
      mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);
      if (!connection || !connection.sock) {
        mcpLogger.error(
          "[MCP Tool Error] send_message failed: WhatsApp connection is not active.",
        );
        return {
          isError: true,
          content: [
            { type: "text", text: "Error: WhatsApp connection is not active or reconnecting." },
          ],
        };
      }

      let normalizedRecipient: string;
      try {
        normalizedRecipient = jidNormalizedUser(recipient);
        if (!normalizedRecipient.includes("@")) {
          throw new Error('JID must contain "@" symbol');
        }
      } catch (normError: any) {
        mcpLogger.error(
          `[MCP Tool Error] Invalid recipient JID format: ${recipient}. Error: ${normError.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid recipient format: "${recipient}". Please provide a valid JID (e.g., number@s.whatsapp.net or group@g.us).`,
            },
          ],
        };
      }

      try {
        const result = await sendWhatsAppMessage(
          waLogger,
          connection,
          normalizedRecipient,
          message,
        );

        if (result && result.key && result.key.id) {
          return {
            content: [
              {
                type: "text",
                text: `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to send message to ${normalizedRecipient}. See server logs for details.`,
              },
            ],
          };
        }
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] send_message failed for ${recipient}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            { type: "text", text: `Error sending message: ${error.message}` },
          ],
        };
      }
    },
  );

  // ─── Tool: search_messages ────────────────────────────────────────
  server.tool(
    "search_messages",
    {
      query: z
        .string()
        .min(1)
        .describe("The text content to search for within messages"),
      chat_jid: z
        .string()
        .optional()
        .describe(
          "Optional: The JID of a specific chat to search within. If omitted, searches all chats.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Max messages per page (default 10)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, query, limit, page }) => {
      const searchScope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
      mcpLogger.info(
        `[MCP Tool] Executing search_messages ${searchScope}, query="${query}", limit=${limit}, page=${page}`,
      );
      try {
        const messages = searchMessages(query, chat_jid, limit, page);

        if (!messages.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No messages found containing "${query}" ${searchScope}.`,
              },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found containing "${query}" on page ${page} ${searchScope}.`,
              },
            ],
          };
        }

        const formattedMessages = messages.map(formatDbMessageForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_messages failed for ${searchScope} / "${query}": ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching messages ${searchScope}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

export async function startMcpServer(
  connection: WhatsAppConnection | null,
  mcpLogger: Logger,
  waLogger: Logger,
  port: number,
): Promise<{ httpServer: Server; mcpServer: McpServer }> {
  mcpLogger.info("Initializing MCP server with Streamable HTTP transport...");

  // Singleton instance returned for shutdown bookkeeping; runtime tool calls
  // use per-request server instances created in the POST /sse handler.
  const mcpServer = createMcpServer(connection, mcpLogger, waLogger);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() || null;
  if (!AUTH_TOKEN) {
    mcpLogger.warn(
      "MCP_AUTH_TOKEN not set — /sse is open to anyone who can reach the port. Set MCP_AUTH_TOKEN for production."
    );
    console.warn(
      "⚠️  MCP_AUTH_TOKEN not set. /sse is unauthenticated. Bind to localhost or set the token."
    );
  }

  // ─── Bearer-token auth middleware (only on /sse) ─────────────
  // Tolerant of:
  //   - "Bearer", "bearer", "BEARER" (RFC 6750 says scheme is case-insensitive)
  //   - leading/trailing whitespace in the header value
  // Strict on the token bytes themselves (no trimming of the token).
  const requireAuth = (req: Request, res: Response, next: () => void) => {
    if (!AUTH_TOKEN) return next();
    const raw = (req.header("authorization") || "").trim();
    const m = raw.match(/^Bearer\s+(.+)$/i);
    const provided = m?.[1];

    if (provided === AUTH_TOKEN) {
      next();
      return;
    }

    // Helpful diagnostic log without leaking the full secret.
    const tokenHint = (s: string | undefined | null) =>
      !s ? "<missing>" : `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})`;
    const reason = !raw
      ? "no Authorization header"
      : !m
        ? `bad scheme (got: \"${raw.slice(0, 16)}…\")`
        : "token mismatch";
    mcpLogger.warn(
      `Unauthorized ${req.method} ${req.path} from ${req.ip} — ${reason}; ` +
        `provided=${tokenHint(provided)} expected=${tokenHint(AUTH_TOKEN)}`
    );
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  };

  // ─── Health check endpoint ──────────────────────────────────────
  app.get("/health", (_req: Request, res: Response) => {
    const connected = !!(connection && connection.sock && connection.sock.user);
    const status = connected ? 200 : 503;
    res.status(status).json({
      status: connected ? "ok" : "degraded",
      whatsapp_connected: connected,
      timestamp: toLocalTime(new Date()),
    });
  });

  // ─── Streamable HTTP: POST /sse — stateless mode ─────────────
  // Per the MCP TS SDK stateless example, create a fresh McpServer + transport
  // per request and tear them down on response close. Using a single shared
  // server across many connect() calls leaks listeners.
  app.post("/sse", requireAuth, async (req: Request, res: Response) => {
    mcpLogger.info(`POST /sse from ${req.ip}`);

    const reqServer = createMcpServer(connection, mcpLogger, waLogger);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close().catch((err) => {
        mcpLogger.error(`Error closing transport: ${err.message}`);
      });
      reqServer.close().catch((err) => {
        mcpLogger.error(`Error closing per-request McpServer: ${err.message}`);
      });
    });

    try {
      await reqServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      mcpLogger.error(`Error handling POST /sse: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // ─── GET & DELETE not supported in stateless mode ─────────────
  app.get("/sse", requireAuth, (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode. Use POST." },
      id: null,
    });
  });

  app.delete("/sse", requireAuth, (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode." },
      id: null,
    });
  });

  // ─── Start the HTTP server ──────────────────────────────────
  return new Promise((resolve) => {
    const httpServer = app.listen(port, "0.0.0.0", () => {
      mcpLogger.info(`MCP server listening on http://0.0.0.0:${port}`);
      console.log(`\n🚀 MCP Server ready at http://0.0.0.0:${port}`);
      console.log(`   MCP endpoint:    http://0.0.0.0:${port}/sse`);
      console.log(`   Health check:    http://0.0.0.0:${port}/health`);
      console.log(
        AUTH_TOKEN
          ? `   Auth:            Bearer token required (set via MCP_AUTH_TOKEN)`
          : `   Auth:            DISABLED — set MCP_AUTH_TOKEN to enable`
      );
      const exampleHeaders = AUTH_TOKEN
        ? `, "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }`
        : "";
      console.log(`\n   Configure your MCP client with:`);
      console.log(`   - Gemini CLI:                 { "httpUrl": "http://<YOUR-IP>:${port}/sse"${exampleHeaders} }`);
      console.log(`   - Claude / Cline / Cursor:    { "url":     "http://<YOUR-IP>:${port}/sse"${exampleHeaders} }\n`);
      console.log(`   ⚠️  Gemini CLI: must use "httpUrl" (Streamable HTTP), not "url" (legacy SSE).\n`);
      resolve({ httpServer, mcpServer });
    });
  });
}
