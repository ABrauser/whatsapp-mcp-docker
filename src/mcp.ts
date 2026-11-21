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
  getMessageById,
  updateMessageContent,
} from "./database.ts";

import { sendWhatsAppMessage, editWhatsAppMessage, scheduleLazyGroupNameFetch, type WhatsAppConnection } from "./whatsapp.ts";
import { getOverride } from "./contactOverrides.ts";
import { resolveByPushName } from "./contactResolver.ts";
import { getDb } from "./database.ts";
import {
  ALL_TOOLS,
  authenticateBearerToken,
  countActiveApiTokens,
  countRecentSends,
  expandAllowedChats,
  isLegacyEnvTokenActive,
  isSendKillSwitchActive,
  listApiTokens,
  normalizeChatJid,
  recordAuditLog,
  type AuditStatus,
  type McpToolName,
  type TokenPrincipal,
} from "./tokens.ts";
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
 *   3. resolved candidate (savedName from the contacts_resolved view, or push
 *      name when no view result) → run through fuzzy as a last-line defense.
 *      Fuzzy is idempotent for genuine saved names (e.g. "Mary Bauer" → "Mary
 *      Bauer") and only changes the value when there is a unique address-book
 *      upgrade (e.g. notify-fallback "Mary Grace Bauer" → saved "Mary Bauer").
 *      This handles the case where the view fell through to a notify string
 *      AND we cannot detect that fall-through (e.g. legacy messages with
 *      sender_push_name=NULL because they pre-date that column).
 *   4. JID prefix when sender is set but everything else is null
 *   5. "Unknown" — no sender JID and no push name (system messages)
 */
export function pickSenderDisplay(opts: {
  isFromMe: boolean;
  override: string | null;
  savedName: string | null;
  pushName: string | null;
  senderJid: string | null;
  fuzzy: (candidate: string) => { name: string } | null;
}): string {
  if (opts.isFromMe) return "Me";
  if (opts.override) return opts.override;

  const candidate = opts.savedName ?? opts.pushName;
  if (candidate) {
    const fuzzy = opts.fuzzy(candidate);
    if (fuzzy) return fuzzy.name;
    return candidate;
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

const FULL_ACCESS_PRINCIPAL: TokenPrincipal = {
  id: "system",
  name: "System (Full Access)",
  allowedTools: new Set<McpToolName>(ALL_TOOLS),
  allowedChats: null,
  maxReqPerMin: null,
  maxSendsPerHour: null,
  isLegacy: false,
};

/**
 * Build a fresh MCP server with tools filtered by the authenticated token's
 * permissions. Per-request creation is required for the stateless Streamable-HTTP
 * pattern to avoid leaking listeners across `transport.connect()` calls.
 */
function createMcpServer(
  connection: WhatsAppConnection | null,
  mcpLogger: Logger,
  waLogger: Logger,
  principal: TokenPrincipal = FULL_ACCESS_PRINCIPAL,
  clientIp: string | null = null,
): McpServer {
  const server = new McpServer({
    name: "whatsapp-mcp-docker",
    version: "1.0.0",
  });

  const allowedChatSet = expandAllowedChats(principal.allowedChats);
  const allowedChatList = allowedChatSet ? [...allowedChatSet] : null;

  const isChatAllowed = (jid: string): boolean => {
    if (allowedChatSet === null) return true;
    if (allowedChatSet.has(jid)) return true;
    const norm = normalizeChatJid(jid);
    return norm ? allowedChatSet.has(norm) : false;
  };

  const audit = (
    toolName: string,
    status: AuditStatus,
    targetJid?: string | null,
    summary?: string | null,
  ) => {
    recordAuditLog({
      tokenId: principal.id,
      tokenName: principal.name,
      clientIp,
      toolName,
      targetJid,
      status,
      summary,
    });
  };

  const denyChat = (toolName: string, chatJid: string, hideJid: boolean = false) => {
    mcpLogger.warn(
      { tokenId: principal.id, tokenName: principal.name, toolName, chatJid },
      `[AuthZ] Denied ${toolName} on chat ${chatJid}`,
    );
    audit(toolName, "denied", chatJid, "Chat not in token allowlist");
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: hideJid
            ? "Access denied: target message does not belong to a chat permitted for this token."
            : `Access denied: chat "${chatJid}" is not permitted for this token.`,
        },
      ],
    };
  };

  // ─── Tool: search_contacts ────────────────────────────────────────
  if (principal.allowedTools.has("search_contacts")) {
    server.tool(
      "search_contacts",
      {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe("Search term for contact name or phone number part of JID"),
      },
      async ({ query }) => {
        mcpLogger.info(
          `[MCP Tool] Executing search_contacts with query: "${query}" (token=${principal.name})`,
        );
        try {
          const contacts = searchDbForContacts(query, 20, allowedChatList);
          const formattedContacts = contacts.map((c) => ({
            jid: c.jid,
            name: c.name ?? c.jid.split("@")[0],
          }));
          audit("search_contacts", "ok", null, `query="${query}" (${formattedContacts.length} results)`);
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
          audit("search_contacts", "error", null, error.message);
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
  }

  // ─── Tool: list_messages ──────────────────────────────────────────
  if (principal.allowedTools.has("list_messages")) {
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
          .max(200)
          .optional()
          .default(20)
          .describe("Max messages per page (default 20, max 200)"),
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
        if (!isChatAllowed(chat_jid)) {
          return denyChat("list_messages", chat_jid);
        }
        mcpLogger.info(
          `[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}, since=${since ?? "-"}, until=${until ?? "-"} (token=${principal.name})`,
        );
        try {
          const messages = getMessages(chat_jid, limit, page, since, until);
          audit("list_messages", "ok", chat_jid, `limit=${limit} page=${page} count=${messages.length}`);
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
          audit("list_messages", "error", chat_jid, error.message);
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
  }

  // ─── Tool: list_recent_messages ───────────────────────────────────
  // Cross-chat time-window query — designed for agent prompts like
  //   "show me the last 8 hours of WhatsApp activity"
  // without needing one tool call per chat.
  if (principal.allowedTools.has("list_recent_messages")) {
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
          .max(500)
          .optional()
          .default(50)
          .describe("Max messages per page (default 50, max 500)"),
        page: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .default(0)
          .describe("Page number (0-indexed, default 0)"),
        include_status: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Include WhatsApp Status broadcasts (the 'Status' tab in the WhatsApp app). Off by default — these are short-lived stories, not regular chat messages. Set to true to fetch them, or use chat_jid='status@broadcast' to query only those.",
          ),
      },
      async ({ hours, since, until, chat_jid, limit, page, include_status }) => {
        if (chat_jid && !isChatAllowed(chat_jid)) {
          return denyChat("list_recent_messages", chat_jid);
        }
        const cappedLimit = Math.min(limit ?? 50, 500);
        const sinceIso =
          since
            ?? new Date(Date.now() - (hours ?? 24) * 3600 * 1000).toISOString();
        const untilIso = until ?? null;
        mcpLogger.info(
          `[MCP Tool] list_recent_messages since=${sinceIso} until=${untilIso ?? "now"} chat=${chat_jid ?? "<all>"} limit=${cappedLimit} page=${page} status=${include_status} (token=${principal.name})`,
        );
        try {
          const messages = getRecentMessages(
            sinceIso,
            untilIso,
            chat_jid ?? null,
            cappedLimit,
            page,
            include_status,
            allowedChatList,
          );
          audit("list_recent_messages", "ok", chat_jid ?? null, `limit=${cappedLimit} count=${messages.length}`);
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
          audit("list_recent_messages", "error", chat_jid ?? null, error.message);
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
  }

  // ─── Tool: list_chats ─────────────────────────────────────────────
  if (principal.allowedTools.has("list_chats")) {
    server.tool(
      "list_chats",
      {
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(20)
          .describe("Max chats per page (default 20, max 100)"),
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
        include_status: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Include the synthetic 'status@broadcast' chat that holds WhatsApp Status updates. Off by default — it is not a real chat between people.",
          ),
      },
      async ({ limit, page, sort_by, query, include_last_message, include_status }) => {
        mcpLogger.info(
          `[MCP Tool] Executing list_chats: limit=${limit}, page=${page}, sort=${sort_by}, query=${query}, lastMsg=${include_last_message}, status=${include_status} (token=${principal.name})`,
        );
        try {
          const chats = getChats(
            limit,
            page,
            sort_by,
            query ?? null,
            include_last_message,
            include_status,
            allowedChatList,
          );
          audit("list_chats", "ok", null, `limit=${limit} page=${page} count=${chats.length}`);
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
          audit("list_chats", "error", null, error.message);
          return {
            isError: true,
            content: [
              { type: "text", text: `Error listing chats: ${error.message}` },
            ],
          };
        }
      },
    );
  }

  // ─── Tool: get_chat ───────────────────────────────────────────────
  if (principal.allowedTools.has("get_chat")) {
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
        if (!isChatAllowed(chat_jid)) {
          return denyChat("get_chat", chat_jid);
        }
        mcpLogger.info(
          `[MCP Tool] Executing get_chat for ${chat_jid}, lastMsg=${include_last_message} (token=${principal.name})`,
        );
        try {
          const chat = getChat(chat_jid, include_last_message);
          if (!chat) {
            audit("get_chat", "error", chat_jid, "Chat not found");
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
          audit("get_chat", "ok", chat_jid, "Retrieved chat");
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
          audit("get_chat", "error", chat_jid, error.message);
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
  }

  // ─── Tool: get_message_context ────────────────────────────────────
  if (principal.allowedTools.has("get_message_context")) {
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
          .max(50)
          .optional()
          .default(5)
          .describe("Number of messages before (default 5, max 50)"),
        after: z
          .number()
          .int()
          .nonnegative()
          .max(50)
          .optional()
          .default(5)
          .describe("Number of messages after (default 5, max 50)"),
      },
      async ({ message_id, before, after }) => {
        mcpLogger.info(
          `[MCP Tool] Executing get_message_context for msg ${message_id}, before=${before}, after=${after} (token=${principal.name})`,
        );
        try {
          const context = getMessagesAround(message_id, before, after);
          if (!context.target) {
            audit("get_message_context", "error", null, `Message ${message_id} not found`);
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
          if (!isChatAllowed(context.target.chat_jid)) {
            return denyChat("get_message_context", context.target.chat_jid, true);
          }
          const formattedContext = {
            target: formatDbMessageForJson(context.target),
            before: context.before.map(formatDbMessageForJson),
            after: context.after.map(formatDbMessageForJson),
          };
          audit("get_message_context", "ok", context.target.chat_jid, `msg=${message_id}`);
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
          audit("get_message_context", "error", null, error.message);
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
  }

  // ─── Tool: send_message ───────────────────────────────────────────
  if (principal.allowedTools.has("send_message")) {
    server.tool(
      "send_message",
      {
        recipient: z
          .string()
          .describe(
            "Recipient JID (user or group, e.g., '12345@s.whatsapp.net' or 'group123@g.us')",
          ),
        message: z.string().min(1).max(4096).describe("The text message to send (max 4096 chars)"),
      },
      async ({ recipient, message }) => {
        if (isSendKillSwitchActive()) {
          mcpLogger.warn(
            { audit: "send_message_blocked", tokenId: principal.id, recipient },
            `[Audit] send_message blocked by Admin Kill-Switch`,
          );
          audit("send_message", "denied", recipient, "Blocked by Admin Send Kill-Switch");
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Outbound messaging is currently paused by the Admin Kill-Switch.",
              },
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
          audit("send_message", "error", recipient, `Invalid JID: ${normError.message}`);
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

        if (!isChatAllowed(normalizedRecipient) && !isChatAllowed(recipient)) {
          return denyChat("send_message", normalizedRecipient);
        }

        if (principal.maxSendsPerHour !== null) {
          const used = countRecentSends(principal.id);
          if (used >= principal.maxSendsPerHour) {
            mcpLogger.warn(
              { tokenId: principal.id, tokenName: principal.name, used, limit: principal.maxSendsPerHour },
              `[Audit] send_message hourly limit reached`,
            );
            audit(
              "send_message",
              "rate_limited",
              normalizedRecipient,
              `Hourly send cap reached (${used}/${principal.maxSendsPerHour})`,
            );
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Send rate limit exceeded (${used}/${principal.maxSendsPerHour} messages in the last hour).`,
                },
              ],
            };
          }
        }

        // Audit log: structured record of every send attempt.
        mcpLogger.info(
          {
            audit: "send_message",
            tokenId: principal.id,
            tokenName: principal.name,
            recipient: normalizedRecipient,
            messageLen: message.length,
            messagePreview: message.slice(0, 80),
          },
          `[Audit] send_message → ${normalizedRecipient} (token=${principal.name})`,
        );

        if (!connection || !connection.sock) {
          mcpLogger.error(
            "[MCP Tool Error] send_message failed: WhatsApp connection is not active.",
          );
          audit("send_message", "error", normalizedRecipient, "WhatsApp disconnected");
          return {
            isError: true,
            content: [
              { type: "text", text: "Error: WhatsApp connection is not active or reconnecting." },
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
                tokenId: principal.id,
                tokenName: principal.name,
                recipient: normalizedRecipient,
                messageId: result.key.id,
              },
              `[Audit] send_message OK ID=${result.key.id}`,
            );
            audit("send_message", "ok", normalizedRecipient, `len=${message.length} id=${result.key.id}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`,
                },
              ],
            };
          } else {
            audit("send_message", "error", normalizedRecipient, "sendWhatsAppMessage returned empty result");
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
          audit("send_message", "error", normalizedRecipient, error.message);
          return {
            isError: true,
            content: [
              { type: "text", text: `Error sending message: ${error.message}` },
            ],
          };
        }
      },
    );
  }

  // ─── Tool: search_messages ────────────────────────────────────────
  if (principal.allowedTools.has("search_messages")) {
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
          .max(100)
          .optional()
          .default(10)
          .describe("Max messages per page (default 10, max 100)"),
        page: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .default(0)
          .describe("Page number (0-indexed, default 0)"),
        include_status: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Include WhatsApp Status broadcasts in the search. Off by default. Use chat_jid='status@broadcast' to search only those.",
          ),
      },
      async ({ chat_jid, query, limit, page, include_status }) => {
        if (chat_jid && !isChatAllowed(chat_jid)) {
          return denyChat("search_messages", chat_jid);
        }
        const searchScope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
        mcpLogger.info(
          `[MCP Tool] Executing search_messages ${searchScope}, query="${query}", limit=${limit}, page=${page}, status=${include_status} (token=${principal.name})`,
        );
        try {
          const messages = searchMessages(
            query,
            chat_jid,
            limit,
            page,
            include_status,
            allowedChatList,
          );
          audit("search_messages", "ok", chat_jid ?? null, `query="${query}" count=${messages.length}`);

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
          audit("search_messages", "error", chat_jid ?? null, error.message);
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
  }

  // ─── Tool: edit_message ───────────────────────────────────────────
  if (principal.allowedTools.has("edit_message")) {
    server.tool(
      "edit_message",
      {
        message_id: z
          .string()
          .describe("The ID of the message to edit (must be a message sent by you)"),
        chat_jid: z
          .string()
          .describe("The JID of the chat the message belongs to"),
        new_text: z
          .string()
          .min(1)
          .max(4096)
          .describe("The new text content to replace the original message with (max 4096 chars)"),
      },
      async ({ message_id, chat_jid, new_text }) => {
        if (isSendKillSwitchActive()) {
          mcpLogger.warn(
            { audit: "edit_message_blocked", tokenId: principal.id, chat_jid, message_id },
            `[Audit] edit_message blocked by Admin Kill-Switch`,
          );
          audit("edit_message", "denied", chat_jid, "Blocked by Admin Send Kill-Switch");
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Outbound messaging is currently paused by the Admin Kill-Switch.",
              },
            ],
          };
        }

        if (!isChatAllowed(chat_jid)) {
          return denyChat("edit_message", chat_jid);
        }

        // Validate that the message exists and check allowlist on its true DB chat_jid
        // before revealing whether it exists or was sent by us.
        const existing = getMessageById(message_id);
        if (existing && !isChatAllowed(existing.chat_jid)) {
          return denyChat("edit_message", existing.chat_jid, true);
        }

        if (principal.maxSendsPerHour !== null) {
          const used = countRecentSends(principal.id);
          if (used >= principal.maxSendsPerHour) {
            audit(
              "edit_message",
              "rate_limited",
              existing?.chat_jid ?? chat_jid,
              `Hourly send cap reached (${used}/${principal.maxSendsPerHour})`,
            );
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Send rate limit exceeded (${used}/${principal.maxSendsPerHour} messages in the last hour).`,
                },
              ],
            };
          }
        }

        mcpLogger.info(
          {
            audit: "edit_message",
            tokenId: principal.id,
            tokenName: principal.name,
            message_id,
            chat_jid,
            newTextLen: new_text.length,
            newTextPreview: new_text.slice(0, 80),
          },
          `[Audit] edit_message → ${chat_jid} / ${message_id} (token=${principal.name})`,
        );

        if (!connection || !connection.sock) {
          mcpLogger.error(
            "[MCP Tool Error] edit_message failed: WhatsApp connection is not active.",
          );
          audit("edit_message", "error", chat_jid, "WhatsApp disconnected");
          return {
            isError: true,
            content: [
              { type: "text", text: "Error: WhatsApp connection is not active or reconnecting." },
            ],
          };
        }

        if (!existing) {
          audit("edit_message", "error", chat_jid, `Message ${message_id} not found`);
          return {
            isError: true,
            content: [
              { type: "text", text: `Message with ID "${message_id}" not found in local database.` },
            ],
          };
        }
        if (!existing.is_from_me) {
          audit("edit_message", "denied", existing.chat_jid, `Message ${message_id} not from user`);
          return {
            isError: true,
            content: [
              { type: "text", text: `Message "${message_id}" was not sent by you. Only your own messages can be edited.` },
            ],
          };
        }

        // Use the chat_jid from the DB as ground truth (in case the caller's differs)
        const resolvedChatJid = existing.chat_jid;

        try {
          const success = await editWhatsAppMessage(
            waLogger,
            connection,
            resolvedChatJid,
            message_id,
            new_text,
          );

          if (success) {
            // Keep local DB in sync so subsequent list_messages reflects the edit
            updateMessageContent(message_id, resolvedChatJid, new_text);
            mcpLogger.info(
              { audit: "edit_message_success", tokenId: principal.id, message_id, chat_jid: resolvedChatJid },
              `[Audit] edit_message OK`,
            );
            audit("edit_message", "ok", resolvedChatJid, `msg=${message_id} len=${new_text.length}`);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message_id,
                    chat_jid: resolvedChatJid,
                    new_text,
                  }, null, 2),
                },
              ],
            };
          } else {
            audit("edit_message", "error", resolvedChatJid, "editWhatsAppMessage returned false");
            return {
              isError: true,
              content: [
                { type: "text", text: `Failed to edit message "${message_id}". See server logs for details.` },
              ],
            };
          }
        } catch (error: any) {
          mcpLogger.error(
            `[MCP Tool Error] edit_message failed for ${message_id}: ${error.message}`,
          );
          audit("edit_message", "error", resolvedChatJid, error.message);
          return {
            isError: true,
            content: [
              { type: "text", text: `Error editing message: ${error.message}` },
            ],
          };
        }
      },
    );
  }

  return server;
}

export interface StartMcpOptions {
  bindHost?: string;
  quiet?: boolean;
}

export async function startMcpServer(
  connection: WhatsAppConnection | null,
  mcpLogger: Logger,
  waLogger: Logger,
  port: number,
  options?: StartMcpOptions,
): Promise<{ httpServer: Server; mcpServer: McpServer; port: number }> {
  mcpLogger.info("Initializing MCP server with Streamable HTTP transport...");

  // Singleton instance returned for shutdown bookkeeping; runtime tool calls
  // use per-request server instances created in the POST /sse handler.
  const mcpServer = createMcpServer(connection, mcpLogger, waLogger, FULL_ACCESS_PRINCIPAL, null);
  const app = express();

  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    if (trustProxy === "true") app.set("trust proxy", true);
    else if (trustProxy === "false") app.set("trust proxy", false);
    else if (/^\d+$/.test(trustProxy)) app.set("trust proxy", Number.parseInt(trustProxy, 10));
    else app.set("trust proxy", trustProxy);
  }

  app.use(express.json({ limit: "1mb" }));

  const allowUnauth = process.env.MCP_ALLOW_UNAUTHENTICATED === "true";
  const legacyActive = isLegacyEnvTokenActive();
  const dbTokenCount = countActiveApiTokens();

  if (allowUnauth && !legacyActive && listApiTokens().length === 0) {
    mcpLogger.warn(
      "MCP_ALLOW_UNAUTHENTICATED=true and no tokens configured — /sse is OPEN without authentication!",
    );
    if (!options?.quiet) {
      console.warn(
        "⚠️  MCP_ALLOW_UNAUTHENTICATED=true and no tokens exist. /sse is unauthenticated.",
      );
    }
  } else if (!legacyActive && dbTokenCount === 0) {
    mcpLogger.warn(
      "No MCP_AUTH_TOKEN or active DB API tokens configured — /sse will fail closed (401) until a token is created in Admin UI or MCP_AUTH_TOKEN is set.",
    );
  }

  // Per-token in-memory sliding window for maxReqPerMin.
  const tokenWindowMap = new Map<string, number[]>();
  const checkTokenRateLimit = (principal: TokenPrincipal): boolean => {
    const limit = principal.maxReqPerMin;
    if (!limit || limit <= 0) return true;
    const now = Date.now();
    const cutoff = now - 60_000;
    const prev = tokenWindowMap.get(principal.id) ?? [];
    const recent = prev.filter((ts) => ts > cutoff);
    if (recent.length >= limit) {
      tokenWindowMap.set(principal.id, recent);
      return false;
    }
    recent.push(now);
    tokenWindowMap.set(principal.id, recent);
    return true;
  };

  // ─── Bearer-token auth middleware (fail-closed) ──────────────
  // Tolerant of case-insensitive "Bearer" scheme and surrounding header whitespace.
  // Never leaks expected token hints in logs.
  const requireAuth = (req: Request, res: Response, next: () => void) => {
    const raw = (req.header("authorization") || "").trim();
    const m = raw.match(/^Bearer\s+(.+)$/i);
    const provided = m?.[1];

    if (
      !raw &&
      process.env.MCP_ALLOW_UNAUTHENTICATED === "true" &&
      !isLegacyEnvTokenActive() &&
      listApiTokens().length === 0
    ) {
      res.locals.principal = FULL_ACCESS_PRINCIPAL;
      next();
      return;
    }

    if (!provided) {
      const reason = !raw ? "no Authorization header" : "bad Authorization scheme";
      mcpLogger.warn(`Unauthorized ${req.method} ${req.path} from ${req.ip} — ${reason}`);
      recordAuditLog({
        tokenId: null,
        tokenName: null,
        clientIp: req.ip ?? null,
        toolName: "auth",
        status: "denied",
        summary: reason,
      });
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }

    const auth = authenticateBearerToken(provided, req.ip ?? null);
    if (!auth.ok) {
      mcpLogger.warn(
        `Unauthorized ${req.method} ${req.path} from ${req.ip} — ${auth.reason}${auth.tokenName ? ` (${auth.tokenName})` : ""}`,
      );
      recordAuditLog({
        tokenId: auth.tokenId ?? null,
        tokenName: auth.tokenName ?? null,
        clientIp: req.ip ?? null,
        toolName: "auth",
        status: "denied",
        summary: auth.reason,
      });
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }

    if (!checkTokenRateLimit(auth.principal)) {
      mcpLogger.warn(
        `Per-token rate limit exceeded for "${auth.principal.name}" (${req.ip})`,
      );
      recordAuditLog({
        tokenId: auth.principal.id,
        tokenName: auth.principal.name,
        clientIp: req.ip ?? null,
        toolName: "rate_limit",
        status: "rate_limited",
        summary: `Exceeded ${auth.principal.maxReqPerMin} req/min`,
      });
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Token rate limit exceeded" },
        id: null,
      });
      return;
    }

    res.locals.principal = auth.principal;
    next();
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

  // ─── Rate limiting (per-IP) on /sse ───────────────────────────
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

  // ─── Streamable HTTP: POST /sse — stateless mode ─────────────
  app.post("/sse", sseLimiter, requireAuth, async (req: Request, res: Response) => {
    const principal: TokenPrincipal = res.locals.principal ?? FULL_ACCESS_PRINCIPAL;
    mcpLogger.info(`POST /sse from ${req.ip} (token=${principal.name})`);

    const reqServer = createMcpServer(
      connection,
      mcpLogger,
      waLogger,
      principal,
      req.ip ?? null,
    );
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
  app.get("/sse", sseLimiter, requireAuth, (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode. Use POST." },
      id: null,
    });
  });

  app.delete("/sse", sseLimiter, requireAuth, (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode." },
      id: null,
    });
  });

  // ─── Start the HTTP server ──────────────────────────────────
  const bindHost = options?.bindHost || "0.0.0.0";
  return new Promise((resolve) => {
    const httpServer = app.listen(port, bindHost, () => {
      const addr = httpServer.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      mcpLogger.info(`MCP server listening on http://${bindHost}:${boundPort}`);
      if (!options?.quiet) {
        const activeDb = countActiveApiTokens();
        const legacyOn = isLegacyEnvTokenActive();
        const adminPort = process.env.MCP_ADMIN_PORT || "3011";
        console.log(`\n🚀 MCP Server ready at http://${bindHost}:${boundPort}`);
        console.log(`   MCP endpoint:    http://${bindHost}:${boundPort}/sse`);
        console.log(`   Health check:    http://${bindHost}:${boundPort}/health`);
        if (adminPort !== "0" && adminPort !== "disabled") {
          console.log(`   Admin UI:        http://${bindHost}:${adminPort}/`);
        }
        console.log(
          `   Auth:            Bearer required (fail-closed) | DB tokens: ${activeDb} | Legacy env token: ${legacyOn ? "active" : "off"}`,
        );
        console.log(`\n   Configure your MCP client with:`);
        console.log(`   - Gemini CLI:                 { "httpUrl": "http://<YOUR-IP>:${boundPort}/sse", "headers": { "Authorization": "Bearer <YOUR_TOKEN>" } }`);
        console.log(`   - Claude / Cline / Cursor:    { "url":     "http://<YOUR-IP>:${boundPort}/sse", "headers": { "Authorization": "Bearer <YOUR_TOKEN>" } }\n`);
        console.log(`   ⚠️  Gemini CLI: must use "httpUrl" (Streamable HTTP), not "url" (legacy SSE).\n`);
      }
      resolve({ httpServer, mcpServer, port: boundPort });
    });
  });
}
