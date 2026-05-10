import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { type Server } from "node:http";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getRecentMessages,
  getChats,
  getChat,
  getMessagesAround,
  searchDbForContacts,
  searchMessages,
} from "./database.ts";

import { sendWhatsAppMessage, scheduleLazyGroupNameFetch, type WhatsAppConnection } from "./whatsapp.ts";
import { getOverride } from "./contactOverrides.ts";
import { resolveByPushName } from "./contactResolver.ts";
import { getDb } from "./database.ts";
import type { Logger } from "pino";

const TZ = process.env.TZ || "Europe/Berlin";

function toLocalTime(date: Date): string {
  // Use sv-SE (Sweden) as a hack to get YYYY-MM-DD HH:mm:ss format
  // which is close to ISO but more readable in chat history.
  return date.toLocaleString("sv-SE", { timeZone: TZ }).replace("T", " ");
}

/**
 * Pure decision-tree for the sender-display string. Extracted from
 * `resolveSenderDisplay` so it can be unit-tested with an injected fuzzy
 * lookup, without needing a real database.
 *
 * Priority (high → low):
 *   1. is_from_me → "Me"
 *   2. manual override on the sender JID
 *   3. saved name from the contacts_resolved view (real address-book name).
 *      EXCEPTION: if the saved name equals the captured push name
 *      (case-insensitive), the view fell through to notify; try fuzzy
 *      first to see if there is a unique address-book entry that matches.
 *   4. fuzzy word-overlap match on push name → unique saved name
 *   5. raw push name (always populated for non-fromMe messages)
 *   6. JID prefix when sender is set but everything else is null
 *   7. "Unknown" — no sender JID and no push name (system messages)
 */
export function pickSenderDisplay(opts: {
  isFromMe: boolean;
  override: string | null;
  savedName: string | null;
  pushName: string | null;
  senderJid: string | null;
  fuzzy: (pushName: string) => { name: string } | null;
}): string {
  if (opts.isFromMe) return "Me";
  if (opts.override) return opts.override;

  const { savedName, pushName } = opts;

  // If the saved name equals the push name (case-insensitive, trimmed), the
  // contacts_resolved view fell through to notify. Try fuzzy to upgrade to
  // a real saved address-book name.
  const looksLikeNotifyFallback =
    !!savedName &&
    !!pushName &&
    savedName.trim().toLowerCase() === pushName.trim().toLowerCase();

  if (looksLikeNotifyFallback && pushName) {
    const fuzzy = opts.fuzzy(pushName);
    if (fuzzy) return fuzzy.name;
    return pushName;
  }

  if (savedName) return savedName;

  if (pushName) {
    const fuzzy = opts.fuzzy(pushName);
    if (fuzzy) return fuzzy.name;
    return pushName;
  }

  if (opts.senderJid) return opts.senderJid.split("@")[0] ?? opts.senderJid;
  return "Unknown";
}

function resolveSenderDisplay(msg: DbMessage): string {
  return pickSenderDisplay({
    isFromMe: !!msg.is_from_me,
    override: getOverride(msg.sender),
    savedName: msg.sender_name ?? null,
    pushName: msg.sender_push_name ?? null,
    senderJid: msg.sender ?? null,
    fuzzy: (push) => resolveByPushName(push, getDb()),
  });
}

function formatDbMessageForJson(msg: DbMessage) {
  const chatOverride = getOverride(msg.chat_jid);
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: chatOverride ?? msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    // Single, fully-resolved name for the LLM. Combines: override > saved
    // address-book name > fuzzy match on push name > push name > JID prefix.
    // For own messages this is "Me" (mirroring is_from_me).
    sender_name: resolveSenderDisplay(msg),
    content: msg.content,
    timestamp: toLocalTime(msg.timestamp),
    is_from_me: msg.is_from_me,
  };
}

function formatDbChatForJson(chat: DbChat) {
  const chatOverride = getOverride(chat.jid);

  // Empty chat (no messages yet) → null. Otherwise reuse the same
  // resolution logic as formatDbMessageForJson so the field is consistent
  // across list_chats and list_recent_messages.
  const hasLastSender = chat.last_is_from_me || !!chat.last_sender;
  const lastSenderName = hasLastSender
    ? pickSenderDisplay({
        isFromMe: !!chat.last_is_from_me,
        override: getOverride(chat.last_sender),
        savedName: chat.last_sender_name ?? null,
        pushName: chat.last_sender_push_name ?? null,
        senderJid: chat.last_sender ?? null,
        fuzzy: (push) => resolveByPushName(push, getDb()),
      })
    : null;

  return {
    jid: chat.jid,
    name: chatOverride ?? chat.name ?? chat.jid.split("@")[0] ?? chat.jid,
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time ? toLocalTime(chat.last_message_time) : null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    // Single resolved name; "Me" when the chat's last message was from us.
    last_sender_name: lastSenderName,
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
      since: z
        .string()
        .optional()
        .describe("Optional ISO-8601 timestamp; only messages at or after this time"),
      until: z
        .string()
        .optional()
        .describe("Optional ISO-8601 timestamp; only messages at or before this time"),
    },
    async ({ chat_jid, limit, page, since, until }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}, since=${since ?? "-"}, until=${until ?? "-"}`,
      );
      try {
        const messages = getMessages(chat_jid, limit, page, since, until);
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

  // ─── Tool: list_recent_messages ───────────────────────────────────
  // Cross-chat time-window query — designed for agent prompts like
  //   "show me the last 8 hours of WhatsApp activity"
  // without needing one tool call per chat.
  server.tool(
    "list_recent_messages",
    {
      hours: z
        .number()
        .positive()
        .optional()
        .describe(
          "How many hours back from now to include. Mutually exclusive with `since`. Defaults to 24 if neither is set.",
        ),
      since: z
        .string()
        .optional()
        .describe(
          "ISO-8601 lower bound (inclusive). If set, overrides `hours`.",
        ),
      until: z
        .string()
        .optional()
        .describe("ISO-8601 upper bound (inclusive). Defaults to now."),
      chat_jid: z
        .string()
        .optional()
        .describe("Optional: restrict to a single chat JID."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(50)
        .describe("Max messages per page (default 50, hard-capped at 500)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ hours, since, until, chat_jid, limit, page }) => {
      const cappedLimit = Math.min(limit ?? 50, 500);
      const sinceIso =
        since
          ?? new Date(Date.now() - (hours ?? 24) * 3600 * 1000).toISOString();
      const untilIso = until ?? null;
      mcpLogger.info(
        `[MCP Tool] list_recent_messages since=${sinceIso} until=${untilIso ?? "now"} chat=${chat_jid ?? "<all>"} limit=${cappedLimit} page=${page}`,
      );
      try {
        const messages = getRecentMessages(
          sinceIso,
          untilIso,
          chat_jid ?? null,
          cappedLimit,
          page,
        );
        if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text:
                  page === 0
                    ? `No messages found between ${sinceIso} and ${untilIso ?? "now"}${chat_jid ? ` in chat ${chat_jid}` : ""}.`
                    : `No more messages on page ${page}.`,
              },
            ],
          };
        }
        const formatted = messages.map(formatDbMessageForJson);
        return {
          content: [
            { type: "text", text: JSON.stringify(formatted, null, 2) },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_recent_messages failed: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing recent messages: ${error.message}`,
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
      // Audit log: structured record of every send attempt. Pino emits this
      // at info level so it survives default log filtering and lands in the
      // rotated wa-logs / mcp-logs files. The full message body is logged at
      // debug only — see truncated audit field below.
      mcpLogger.info(
        {
          audit: "send_message",
          recipient,
          messageLen: message.length,
          messagePreview: message.slice(0, 80),
        },
        `[Audit] send_message → ${recipient}`,
      );
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
          mcpLogger.info(
            {
              audit: "send_message_success",
              recipient: normalizedRecipient,
              messageId: result.key.id,
            },
            `[Audit] send_message OK ID=${result.key.id}`,
          );
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
  // ─── Rate limiting (per-IP) on /sse ───────────────────────
  // Defends against a leaked Bearer token being used to flood the endpoint.
  // Defaults are deliberately generous; tighten via MCP_RATE_LIMIT_PER_MIN.
  const rateLimitPerMin = Number.parseInt(
    process.env.MCP_RATE_LIMIT_PER_MIN ?? "120",
    10,
  );
  const sseLimiter = rateLimit({
    windowMs: 60_000,
    limit: Number.isFinite(rateLimitPerMin) && rateLimitPerMin > 0 ? rateLimitPerMin : 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => {
      mcpLogger.warn(
        `Rate limit exceeded for ${req.ip} on ${req.method} ${req.path}`,
      );
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Rate limit exceeded" },
        id: null,
      });
    },
  });

  app.post("/sse", sseLimiter, requireAuth, async (req: Request, res: Response) => {
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
