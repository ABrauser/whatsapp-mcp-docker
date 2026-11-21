import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  initializeDatabase,
  closeDatabase,
  getDb,
  storeChat,
  storeContact,
  storeLidAlias,
} from "../src/database.ts";
import {
  authenticateBearerToken,
  countRecentSends,
  createApiToken,
  deleteApiToken,
  expandAllowedChats,
  getApiTokenById,
  getOrCreateAdminSessionSecret,
  isSendKillSwitchActive,
  listApiTokens,
  listAuditLogs,
  pruneAuditLogs,
  recordAuditLog,
  revokeApiToken,
  setLegacyTokenDisabled,
  setSendKillSwitch,
  updateApiToken,
} from "../src/tokens.ts";

let tmpDir: string;
let prevDataDir: string | undefined;
let prevLegacyToken: string | undefined;
let prevDisableLegacy: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wamcp-tokens-test-"));
  prevDataDir = process.env.WHATSAPP_MCP_DATA_DIR;
  prevLegacyToken = process.env.MCP_AUTH_TOKEN;
  prevDisableLegacy = process.env.MCP_DISABLE_LEGACY_TOKEN;
  process.env.WHATSAPP_MCP_DATA_DIR = tmpDir;
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_DISABLE_LEGACY_TOKEN;
  initializeDatabase();
});

afterEach(() => {
  closeDatabase();
  if (prevDataDir === undefined) delete process.env.WHATSAPP_MCP_DATA_DIR;
  else process.env.WHATSAPP_MCP_DATA_DIR = prevDataDir;
  if (prevLegacyToken === undefined) delete process.env.MCP_AUTH_TOKEN;
  else process.env.MCP_AUTH_TOKEN = prevLegacyToken;
  if (prevDisableLegacy === undefined) delete process.env.MCP_DISABLE_LEGACY_TOKEN;
  else process.env.MCP_DISABLE_LEGACY_TOKEN = prevDisableLegacy;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("createApiToken stores SHA-256 hash only and authenticates valid tokens", () => {
  const { rawToken, record } = createApiToken({
    name: "OpenClaw",
    description: "Home assistant",
    preset: "read_all",
  });

  assert.ok(rawToken.startsWith("wamcp_"));
  assert.equal(record.tokenPrefix, rawToken.slice(0, 12));
  assert.equal((record as any).tokenHash, undefined);
  assert.equal((record as any).token_hash, undefined);

  const row = getDb()
    .prepare(`SELECT token_hash FROM api_tokens WHERE id = ?`)
    .get(record.id) as { token_hash: string };
  assert.notEqual(row.token_hash, rawToken);
  assert.equal(row.token_hash.length, 64);

  const auth = authenticateBearerToken(rawToken, "192.168.1.50");
  assert.equal(auth.ok, true);
  if (auth.ok) {
    assert.equal(auth.principal.id, record.id);
    assert.equal(auth.principal.name, "OpenClaw");
    assert.equal(auth.principal.isLegacy, false);
    assert.equal(auth.principal.allowedTools.has("list_chats"), true);
    assert.equal(auth.principal.allowedTools.has("send_message"), false);
  }

  const refreshed = getApiTokenById(record.id)!;
  assert.equal(refreshed.requestCount, 1);
  assert.equal(refreshed.lastUsedIp, "192.168.1.50");
  assert.ok(refreshed.lastUsedAt);
});

test("authenticateBearerToken handles invalid, disabled, revoked, and expired states", () => {
  assert.deepEqual(authenticateBearerToken("wamcp_does_not_exist"), {
    ok: false,
    reason: "token_invalid",
  });

  const { rawToken, record } = createApiToken({ name: "Temp", preset: "read_all" });

  updateApiToken(record.id, { enabled: false });
  const disabledRes = authenticateBearerToken(rawToken);
  assert.equal(disabledRes.ok, false);
  if (!disabledRes.ok) assert.equal(disabledRes.reason, "token_disabled");

  updateApiToken(record.id, { enabled: true });
  assert.equal(authenticateBearerToken(rawToken).ok, true);

  updateApiToken(record.id, { expiresAt: new Date(Date.now() - 10_000).toISOString() });
  const expiredRes = authenticateBearerToken(rawToken);
  assert.equal(expiredRes.ok, false);
  if (!expiredRes.ok) assert.equal(expiredRes.reason, "token_expired");

  updateApiToken(record.id, { expiresAt: null });
  assert.equal(authenticateBearerToken(rawToken).ok, true);

  revokeApiToken(record.id);
  const revokedRes = authenticateBearerToken(rawToken);
  assert.equal(revokedRes.ok, false);
  if (!revokedRes.ok) assert.equal(revokedRes.reason, "token_revoked");

  assert.equal(listApiTokens().length, 1);
  assert.equal(deleteApiToken(record.id), true);
  assert.equal(listApiTokens().length, 0);
});

test("authenticateBearerToken supports legacy MCP_AUTH_TOKEN and fail-closed controls", () => {
  process.env.MCP_AUTH_TOKEN = "legacy-secret-123";

  const okRes = authenticateBearerToken("legacy-secret-123");
  assert.equal(okRes.ok, true);
  if (okRes.ok) {
    assert.equal(okRes.principal.isLegacy, true);
    assert.equal(okRes.principal.allowedTools.has("send_message"), true);
    assert.equal(okRes.principal.allowedChats, null);
  }

  setLegacyTokenDisabled(true);
  assert.equal(authenticateBearerToken("legacy-secret-123").ok, false);

  setLegacyTokenDisabled(false);
  assert.equal(authenticateBearerToken("legacy-secret-123").ok, true);

  process.env.MCP_DISABLE_LEGACY_TOKEN = "true";
  assert.equal(authenticateBearerToken("legacy-secret-123").ok, false);

  delete process.env.MCP_DISABLE_LEGACY_TOKEN;
  delete process.env.MCP_AUTH_TOKEN;
  assert.equal(authenticateBearerToken("").ok, false);
});

test("expandAllowedChats includes bidirectional @lid <-> @s.whatsapp.net aliases", () => {
  storeContact({ jid: "4917611122233@s.whatsapp.net", name: "Alice" });
  storeChat({ jid: "4917611122233@s.whatsapp.net", name: "Alice" });
  storeLidAlias("998877665544@lid", "4917611122233@s.whatsapp.net");

  const fromS = expandAllowedChats(["4917611122233:2@s.whatsapp.net"]);
  assert.ok(fromS);
  assert.equal(fromS.has("4917611122233@s.whatsapp.net"), true);
  assert.equal(fromS.has("998877665544@lid"), true);

  const fromLid = expandAllowedChats(["998877665544@lid"]);
  assert.ok(fromLid);
  assert.equal(fromLid.has("4917611122233@s.whatsapp.net"), true);
  assert.equal(fromLid.has("998877665544@lid"), true);

  assert.equal(expandAllowedChats(null), null);
});

test("audit logs record, filter, countRecentSends, and prune", () => {
  recordAuditLog({
    tokenId: "tok-1",
    tokenName: "Agent A",
    clientIp: "10.0.0.2",
    toolName: "send_message",
    targetJid: "123@s.whatsapp.net",
    status: "ok",
    summary: "Sent hello",
  });
  recordAuditLog({
    tokenId: "tok-1",
    tokenName: "Agent A",
    clientIp: "10.0.0.2",
    toolName: "edit_message",
    targetJid: "123@s.whatsapp.net",
    status: "ok",
    summary: "Edited msg",
  });
  recordAuditLog({
    tokenId: "tok-1",
    tokenName: "Agent A",
    clientIp: "10.0.0.2",
    toolName: "send_message",
    targetJid: "999@s.whatsapp.net",
    status: "denied",
    summary: "Not allowed",
  });

  assert.equal(countRecentSends("tok-1"), 2);

  const filtered = listAuditLogs({ tokenId: "tok-1", status: "denied" });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.logs[0].targetJid, "999@s.whatsapp.net");

  // Insert an old row directly and test age pruning
  const oldTs = new Date(Date.now() - 40 * 86_400_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO audit_logs (timestamp, token_id, token_name, client_ip, tool_name, target_jid, status, summary)
       VALUES (?, 'tok-old', 'Old', '127.0.0.1', 'list_chats', NULL, 'ok', 'old')`,
    )
    .run(oldTs);

  const deleted = pruneAuditLogs(30, 2);
  assert.equal(deleted, 2);
  assert.equal(listAuditLogs().total, 2);
});

test("settings store handles send kill-switch and idempotent admin session secret", () => {
  assert.equal(isSendKillSwitchActive(), false);
  setSendKillSwitch(true);
  assert.equal(isSendKillSwitchActive(), true);
  setSendKillSwitch(false);
  assert.equal(isSendKillSwitchActive(), false);

  const s1 = getOrCreateAdminSessionSecret();
  const s2 = getOrCreateAdminSessionSecret();
  assert.ok(s1.length >= 64);
  assert.equal(s1, s2);
});
