/**
 * Integration tests verifying that getRecentMessages, getChats, and
 * searchMessages exclude the synthetic `status@broadcast` chat by default
 * and only include it when the caller opts in.
 */
import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initializeDatabase,
  closeDatabase,
  storeChat,
  storeMessage,
  getRecentMessages,
  getChats,
  searchMessages,
  STATUS_BROADCAST_JID,
} from "../src/database.ts";

let tmpDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wamcp-status-test-"));
  prevDataDir = process.env.WHATSAPP_MCP_DATA_DIR;
  process.env.WHATSAPP_MCP_DATA_DIR = tmpDir;
  initializeDatabase();
});

afterEach(() => {
  closeDatabase();
  if (prevDataDir === undefined) delete process.env.WHATSAPP_MCP_DATA_DIR;
  else process.env.WHATSAPP_MCP_DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function seed() {
  const now = new Date("2026-05-10T12:00:00Z");

  storeChat({ jid: "12345@s.whatsapp.net", name: "Real Person", last_message_time: now });
  storeChat({ jid: STATUS_BROADCAST_JID, name: null, last_message_time: now });

  storeMessage({
    id: "msg-real-1",
    chat_jid: "12345@s.whatsapp.net",
    sender: "12345@s.whatsapp.net",
    content: "hello world",
    timestamp: now,
    is_from_me: false,
  });
  storeMessage({
    id: "msg-status-1",
    chat_jid: STATUS_BROADCAST_JID,
    sender: "67890@s.whatsapp.net",
    content: "[Status] beautiful afternoon",
    timestamp: now,
    is_from_me: false,
  });
}

test("getRecentMessages excludes status@broadcast by default", () => {
  seed();
  const since = new Date("2026-05-10T00:00:00Z").toISOString();
  const rows = getRecentMessages(since);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chat_jid, "12345@s.whatsapp.net");
});

test("getRecentMessages includes status@broadcast when includeStatus=true", () => {
  seed();
  const since = new Date("2026-05-10T00:00:00Z").toISOString();
  const rows = getRecentMessages(since, null, null, 50, 0, true);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((m) => m.chat_jid === STATUS_BROADCAST_JID));
});

test("getRecentMessages: explicit chat_jid='status@broadcast' bypasses the filter", () => {
  seed();
  const since = new Date("2026-05-10T00:00:00Z").toISOString();
  const rows = getRecentMessages(since, null, STATUS_BROADCAST_JID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chat_jid, STATUS_BROADCAST_JID);
});

test("getChats excludes status@broadcast by default", () => {
  seed();
  const chats = getChats();
  assert.ok(chats.every((c) => c.jid !== STATUS_BROADCAST_JID));
});

test("getChats includes status@broadcast when includeStatus=true", () => {
  seed();
  const chats = getChats(20, 0, "last_active", null, true, true);
  assert.ok(chats.some((c) => c.jid === STATUS_BROADCAST_JID));
});

test("getChats: query+filter both active still applies status exclusion", () => {
  seed();
  const chats = getChats(20, 0, "last_active", "Real");
  assert.equal(chats.length, 1);
  assert.equal(chats[0].jid, "12345@s.whatsapp.net");
});

test("searchMessages excludes status@broadcast by default", () => {
  seed();
  const rows = searchMessages("status");
  assert.equal(rows.length, 0, "must not return the status row by default");
});

test("searchMessages includes status@broadcast when includeStatus=true", () => {
  seed();
  const rows = searchMessages("status", null, 10, 0, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chat_jid, STATUS_BROADCAST_JID);
});

test("searchMessages: explicit chat_jid='status@broadcast' bypasses filter", () => {
  seed();
  const rows = searchMessages("afternoon", STATUS_BROADCAST_JID);
  assert.equal(rows.length, 1);
});
