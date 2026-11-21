import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";

import {
  initializeDatabase,
  closeDatabase,
  storeChat,
  storeContact,
  storeMessage,
} from "../src/database.ts";
import { startMcpServer } from "../src/mcp.ts";
import { createApiToken, setSendKillSwitch } from "../src/tokens.ts";
import type { WhatsAppConnection } from "../src/whatsapp.ts";

let tmpDir: string;
let prevDataDir: string | undefined;
let prevAuthToken: string | undefined;
let prevAllowUnauth: string | undefined;

let baseUrl: string;
let stopServer: () => Promise<void>;
let sentMessages: { jid: string; text: string }[];
let editedMessages: { jid: string; id: string; text: string }[];

const silentLogger = pino({ level: "silent" });

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${baseUrl}/sse`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();
  if (contentType.includes("text/event-stream")) {
    const dataLines = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = dataLines[dataLines.length - 1];
    return { status: res.status, body: last ? JSON.parse(last) : null };
  }
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

function seedData() {
  const t1 = new Date("2026-10-01T10:00:00Z");
  const t2 = new Date("2026-10-01T10:05:00Z");

  storeContact({ jid: "11111@s.whatsapp.net", name: "Alice Allowed" });
  storeContact({ jid: "22222@s.whatsapp.net", name: "Bob Secret" });

  storeChat({ jid: "11111@s.whatsapp.net", name: "Alice Allowed", last_message_time: t2 });
  storeChat({ jid: "22222@s.whatsapp.net", name: "Bob Secret", last_message_time: t2 });

  storeMessage({
    id: "msg-alice-1",
    chat_jid: "11111@s.whatsapp.net",
    sender: "11111@s.whatsapp.net",
    content: "hello alpha keyword",
    timestamp: t1,
    is_from_me: false,
  });
  storeMessage({
    id: "msg-alice-me",
    chat_jid: "11111@s.whatsapp.net",
    sender: null,
    content: "my own alice message",
    timestamp: t2,
    is_from_me: true,
  });
  storeMessage({
    id: "msg-bob-1",
    chat_jid: "22222@s.whatsapp.net",
    sender: "22222@s.whatsapp.net",
    content: "secret alpha keyword",
    timestamp: t1,
    is_from_me: false,
  });
  storeMessage({
    id: "msg-bob-me",
    chat_jid: "22222@s.whatsapp.net",
    sender: null,
    content: "my own secret message",
    timestamp: t2,
    is_from_me: true,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wamcp-mcpauth-test-"));
  prevDataDir = process.env.WHATSAPP_MCP_DATA_DIR;
  prevAuthToken = process.env.MCP_AUTH_TOKEN;
  prevAllowUnauth = process.env.MCP_ALLOW_UNAUTHENTICATED;

  process.env.WHATSAPP_MCP_DATA_DIR = tmpDir;
  process.env.MCP_AUTH_TOKEN = "legacy-full-token-xyz";
  delete process.env.MCP_ALLOW_UNAUTHENTICATED;

  initializeDatabase();
  seedData();

  sentMessages = [];
  editedMessages = [];

  const mockConn: WhatsAppConnection = {
    latestQr: null,
    sock: {
      user: { id: "99999@s.whatsapp.net", name: "Test User" },
      sendMessage: async (jid: string, content: { text: string }) => {
        sentMessages.push({ jid, text: content.text });
        return { key: { id: `sent-${sentMessages.length}` } } as any;
      },
      relayMessage: async (jid: string, msg: any) => {
        editedMessages.push({
          jid,
          id: msg?.protocolMessage?.key?.id ?? "",
          text: msg?.protocolMessage?.editedMessage?.conversation ?? "",
        });
      },
    } as any,
  };

  const started = await startMcpServer(mockConn, silentLogger, silentLogger, 0, {
    bindHost: "127.0.0.1",
    quiet: true,
  });
  baseUrl = `http://127.0.0.1:${started.port}`;
  stopServer = async () => {
    await started.mcpServer.close();
    await new Promise<void>((resolve) => started.httpServer.close(() => resolve()));
  };
});

afterEach(async () => {
  await stopServer();
  closeDatabase();
  if (prevDataDir === undefined) delete process.env.WHATSAPP_MCP_DATA_DIR;
  else process.env.WHATSAPP_MCP_DATA_DIR = prevDataDir;
  if (prevAuthToken === undefined) delete process.env.MCP_AUTH_TOKEN;
  else process.env.MCP_AUTH_TOKEN = prevAuthToken;
  if (prevAllowUnauth === undefined) delete process.env.MCP_ALLOW_UNAUTHENTICATED;
  else process.env.MCP_ALLOW_UNAUTHENTICATED = prevAllowUnauth;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("fail-closed auth rejects missing and wrong tokens", async () => {
  const noAuth = await rpc("tools/list");
  assert.equal(noAuth.status, 401);

  const badAuth = await rpc("tools/list", {}, "wrong-token");
  assert.equal(badAuth.status, 401);

  const getRes = await fetch(`${baseUrl}/sse`);
  assert.equal(getRes.status, 401);
});

test("legacy MCP_AUTH_TOKEN keeps full access to all 9 tools", async () => {
  const listRes = await rpc("tools/list", {}, "legacy-full-token-xyz");
  assert.equal(listRes.status, 200);
  const names = (listRes.body.result.tools as { name: string }[]).map((t) => t.name).sort();
  assert.deepEqual(names, [
    "edit_message",
    "get_chat",
    "get_message_context",
    "list_chats",
    "list_messages",
    "list_recent_messages",
    "search_contacts",
    "search_messages",
    "send_message",
  ]);

  const sendRes = await rpc(
    "tools/call",
    {
      name: "send_message",
      arguments: { recipient: "11111@s.whatsapp.net", message: "hello from legacy" },
    },
    "legacy-full-token-xyz",
  );
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.body.result.isError, undefined);
  assert.equal(sentMessages.length, 1);
});

test("read-only token hides write tools from tools/list and blocks execution", async () => {
  const { rawToken } = createApiToken({
    name: "Reader",
    preset: "read_all",
  });

  const listRes = await rpc("tools/list", {}, rawToken);
  assert.equal(listRes.status, 200);
  const names = (listRes.body.result.tools as { name: string }[]).map((t) => t.name);
  assert.equal(names.length, 7);
  assert.equal(names.includes("send_message"), false);
  assert.equal(names.includes("edit_message"), false);

  const sendCall = await rpc(
    "tools/call",
    {
      name: "send_message",
      arguments: { recipient: "11111@s.whatsapp.net", message: "sneaky" },
    },
    rawToken,
  );
  assert.equal(sendCall.status, 200);
  assert.ok(sendCall.body.error || sendCall.body.result?.isError);
  assert.equal(sentMessages.length, 0);
});

test("chat-restricted token is strictly confined across all read and write tools", async () => {
  const { rawToken } = createApiToken({
    name: "Alice Only",
    preset: "custom",
    allowedTools: [
      "search_contacts",
      "list_messages",
      "list_recent_messages",
      "list_chats",
      "get_chat",
      "get_message_context",
      "search_messages",
      "send_message",
      "edit_message",
    ],
    allowedChats: ["11111@s.whatsapp.net"],
  });

  // list_chats
  const chatsRes = await rpc("tools/call", { name: "list_chats", arguments: {} }, rawToken);
  const chats = JSON.parse(chatsRes.body.result.content[0].text);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].jid, "11111@s.whatsapp.net");

  // list_messages (allowed vs denied)
  const msgsAllowed = await rpc(
    "tools/call",
    { name: "list_messages", arguments: { chat_jid: "11111@s.whatsapp.net" } },
    rawToken,
  );
  assert.equal(msgsAllowed.body.result.isError, undefined);

  const msgsDenied = await rpc(
    "tools/call",
    { name: "list_messages", arguments: { chat_jid: "22222@s.whatsapp.net" } },
    rawToken,
  );
  assert.equal(msgsDenied.body.result.isError, true);

  // list_recent_messages
  const recentRes = await rpc(
    "tools/call",
    { name: "list_recent_messages", arguments: { since: "2026-01-01T00:00:00Z" } },
    rawToken,
  );
  const recent = JSON.parse(recentRes.body.result.content[0].text);
  assert.ok(recent.every((m: any) => m.chat_jid === "11111@s.whatsapp.net"));

  // search_messages
  const searchRes = await rpc(
    "tools/call",
    { name: "search_messages", arguments: { query: "alpha" } },
    rawToken,
  );
  const found = JSON.parse(searchRes.body.result.content[0].text);
  assert.equal(found.length, 1);
  assert.equal(found[0].chat_jid, "11111@s.whatsapp.net");

  // get_chat (disallowed)
  const chatDenied = await rpc(
    "tools/call",
    { name: "get_chat", arguments: { chat_jid: "22222@s.whatsapp.net" } },
    rawToken,
  );
  assert.equal(chatDenied.body.result.isError, true);

  // get_message_context (message in disallowed chat)
  const ctxDenied = await rpc(
    "tools/call",
    { name: "get_message_context", arguments: { message_id: "msg-bob-1" } },
    rawToken,
  );
  assert.equal(ctxDenied.body.result.isError, true);
  assert.doesNotMatch(ctxDenied.body.result.content[0].text, /22222/);

  // search_contacts ("e" matches both "Alice Allowed" and "Bob Secret", must only return Alice)
  const contactsRes = await rpc(
    "tools/call",
    { name: "search_contacts", arguments: { query: "e" } },
    rawToken,
  );
  const contacts = JSON.parse(contactsRes.body.result.content[0].text);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].jid, "11111@s.whatsapp.net");

  // send_message (allowed vs denied)
  const sendDenied = await rpc(
    "tools/call",
    { name: "send_message", arguments: { recipient: "22222@s.whatsapp.net", message: "nope" } },
    rawToken,
  );
  assert.equal(sendDenied.body.result.isError, true);

  const sendAllowed = await rpc(
    "tools/call",
    { name: "send_message", arguments: { recipient: "11111@s.whatsapp.net", message: "ok" } },
    rawToken,
  );
  assert.equal(sendAllowed.body.result.isError, undefined);
  assert.equal(sentMessages.length, 1);

  // edit_message (attempting to edit Bob's message even by passing Alice's chat_jid!)
  const editDenied = await rpc(
    "tools/call",
    {
      name: "edit_message",
      arguments: { message_id: "msg-bob-me", chat_jid: "11111@s.whatsapp.net", new_text: "hack" },
    },
    rawToken,
  );
  assert.equal(editDenied.body.result.isError, true);
  assert.equal(editedMessages.length, 0);
});

test("send kill-switch, pagination caps, and per-token rate limit", async () => {
  setSendKillSwitch(true);
  const sendBlocked = await rpc(
    "tools/call",
    {
      name: "send_message",
      arguments: { recipient: "11111@s.whatsapp.net", message: "blocked" },
    },
    "legacy-full-token-xyz",
  );
  assert.equal(sendBlocked.body.result.isError, true);
  assert.match(sendBlocked.body.result.content[0].text, /Kill-Switch/i);
  assert.equal(sentMessages.length, 0);

  const editBlocked = await rpc(
    "tools/call",
    {
      name: "edit_message",
      arguments: {
        message_id: "msg-alice-me",
        chat_jid: "11111@s.whatsapp.net",
        new_text: "blocked edit",
      },
    },
    "legacy-full-token-xyz",
  );
  assert.equal(editBlocked.body.result.isError, true);

  // Pagination cap rejects excessive limit
  const capped = await rpc(
    "tools/call",
    { name: "list_chats", arguments: { limit: 999 } },
    "legacy-full-token-xyz",
  );
  assert.ok(capped.body.error || capped.body.result?.isError);

  // Per-token rate limit (maxReqPerMin: 2)
  const { rawToken } = createApiToken({
    name: "TightLimit",
    preset: "read_all",
    maxReqPerMin: 2,
  });
  assert.equal((await rpc("tools/list", {}, rawToken)).status, 200);
  assert.equal((await rpc("tools/list", {}, rawToken)).status, 200);
  assert.equal((await rpc("tools/list", {}, rawToken)).status, 429);
});
