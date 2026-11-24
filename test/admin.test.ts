import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";

import { initializeDatabase, closeDatabase, storeChat, storeContact } from "../src/database.ts";
import { startAdminServer } from "../src/admin.ts";
import type { WhatsAppConnection } from "../src/whatsapp.ts";

let tmpDir: string;
let prevDataDir: string | undefined;
let prevAdminPassword: string | undefined;
let prevAuthToken: string | undefined;

const silentLogger = pino({ level: "silent" });

async function startTestAdmin(
  adminPassword: string | null,
  connection: WhatsAppConnection,
) {
  const started = await startAdminServer(connection, silentLogger, {
    adminPort: 0,
    adminBind: "127.0.0.1",
    mcpPort: 3010,
    adminPassword,
    quiet: true,
  });
  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    close: () =>
      new Promise<void>((resolve) => started.httpServer.close(() => resolve())),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wamcp-admin-test-"));
  prevDataDir = process.env.WHATSAPP_MCP_DATA_DIR;
  prevAdminPassword = process.env.MCP_ADMIN_PASSWORD;
  prevAuthToken = process.env.MCP_AUTH_TOKEN;

  process.env.WHATSAPP_MCP_DATA_DIR = tmpDir;
  delete process.env.MCP_ADMIN_PASSWORD;
  process.env.MCP_AUTH_TOKEN = "legacy-test-token";

  initializeDatabase();
  storeChat({
    jid: "491761234567@s.whatsapp.net",
    name: "Test Contact",
    last_message_time: new Date("2026-10-01T12:00:00Z"),
  });
  storeChat({
    jid: "120363000999@g.us",
    name: "Test Group",
    last_message_time: new Date("2026-10-01T11:00:00Z"),
  });
  storeContact({
    jid: "491767654321@s.whatsapp.net",
    name: "Contact Only Person",
  });
});

afterEach(() => {
  closeDatabase();
  if (prevDataDir === undefined) delete process.env.WHATSAPP_MCP_DATA_DIR;
  else process.env.WHATSAPP_MCP_DATA_DIR = prevDataDir;
  if (prevAdminPassword === undefined) delete process.env.MCP_ADMIN_PASSWORD;
  else process.env.MCP_ADMIN_PASSWORD = prevAdminPassword;
  if (prevAuthToken === undefined) delete process.env.MCP_AUTH_TOKEN;
  else process.env.MCP_AUTH_TOKEN = prevAuthToken;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("fail-closed 503 when MCP_ADMIN_PASSWORD is unset, while GET / still serves UI", async () => {
  const conn: WhatsAppConnection = { sock: null, latestQr: null };
  const srv = await startTestAdmin(null, conn);
  try {
    const htmlRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.headers.get("content-security-policy"));
    assert.equal(htmlRes.headers.get("x-frame-options"), "DENY");
    assert.equal(htmlRes.headers.get("x-content-type-options"), "nosniff");

    const statusRes = await fetch(`${srv.baseUrl}/api/auth/status`);
    assert.equal(statusRes.status, 200);
    assert.deepEqual(await statusRes.json(), { configured: false, authenticated: false });

    const tokensRes = await fetch(`${srv.baseUrl}/api/tokens`);
    assert.equal(tokensRes.status, 503);

    const loginRes = await fetch(`${srv.baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "anything" }),
    });
    assert.equal(loginRes.status, 503);
  } finally {
    await srv.close();
  }
});

test("login, cookie security flags, CSRF enforcement, token CRUD, settings, audit & local QR", async () => {
  const conn: WhatsAppConnection = {
    sock: null,
    latestQr: "2@dummy-whatsapp-pairing-qr-payload,123456",
  };
  const srv = await startTestAdmin("super-secret-admin-pw", conn);

  try {
    // Unauthenticated access rejected
    const unauth = await fetch(`${srv.baseUrl}/api/tokens`);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("cache-control"), "no-store");

    // Wrong password rejected
    const badLogin = await fetch(`${srv.baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(badLogin.status, 401);

    // Right password sets HttpOnly + SameSite=Strict cookie
    const okLogin = await fetch(`${srv.baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "super-secret-admin-pw" }),
    });
    assert.equal(okLogin.status, 200);
    const setCookie = okLogin.headers.get("set-cookie") || "";
    assert.match(setCookie, /wamcp_admin_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookieHeader = setCookie.split(";")[0];

    // CSRF check blocks mutations without X-Requested-With: fetch
    const csrfFail = await fetch(`${srv.baseUrl}/api/tokens`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "NoCsrf", preset: "read_all" }),
    });
    assert.equal(csrfFail.status, 403);

    // Status includes local SVG QR when disconnected
    const statusRes = await fetch(`${srv.baseUrl}/api/status`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as any;
    assert.equal(statusBody.whatsappConnected, false);
    assert.match(statusBody.qrSvg, /^<svg /);
    assert.equal(statusBody.legacyTokenActive, true);

    // When connected, qrSvg becomes null
    conn.sock = { user: { id: "me@s.whatsapp.net", name: "Me" } } as any;
    conn.latestQr = null;
    const statusConnected = await (
      await fetch(`${srv.baseUrl}/api/status`, { headers: { Cookie: cookieHeader } })
    ).json() as any;
    assert.equal(statusConnected.whatsappConnected, true);
    assert.equal(statusConnected.qrSvg, null);

    // Chats endpoint returns seeded chats & contacts and supports type/query filters
    const chatsRes = await fetch(`${srv.baseUrl}/api/chats`, {
      headers: { Cookie: cookieHeader },
    });
    const chatsData = (await chatsRes.json()) as any;
    assert.equal(chatsData.chats.length, 3);
    assert.equal(chatsData.chats[0].jid, "491761234567@s.whatsapp.net");

    const personsRes = await fetch(`${srv.baseUrl}/api/chats?type=person`, {
      headers: { Cookie: cookieHeader },
    });
    const personsData = (await personsRes.json()) as any;
    assert.equal(personsData.chats.length, 2);
    assert.ok(personsData.chats.every((c: any) => !c.isGroup));

    const groupsRes = await fetch(`${srv.baseUrl}/api/chats?type=group`, {
      headers: { Cookie: cookieHeader },
    });
    const groupsData = (await groupsRes.json()) as any;
    assert.equal(groupsData.chats.length, 1);
    assert.equal(groupsData.chats[0].jid, "120363000999@g.us");

    const searchRes = await fetch(`${srv.baseUrl}/api/chats?type=person&q=Contact%20Only`, {
      headers: { Cookie: cookieHeader },
    });
    const searchData = (await searchRes.json()) as any;
    assert.equal(searchData.chats.length, 1);
    assert.equal(searchData.chats[0].jid, "491767654321@s.whatsapp.net");
    assert.equal(searchData.chats[0].isContactOnly, true);

    // Token CRUD
    const createRes = await fetch(`${srv.baseUrl}/api/tokens`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify({
        name: "My Agent",
        preset: "read_chats",
        allowedChats: ["491761234567@s.whatsapp.net"],
        ttlHours: 24,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as any;
    assert.ok(created.token.startsWith("wamcp_"));
    assert.equal(created.record.name, "My Agent");
    assert.deepEqual(created.record.allowedChats, ["491761234567@s.whatsapp.net"]);

    const listRes = await fetch(`${srv.baseUrl}/api/tokens`, {
      headers: { Cookie: cookieHeader },
    });
    const listed = (await listRes.json()) as any;
    assert.equal(listed.tokens.length, 1);
    assert.equal(listed.tokens[0].tokenHash, undefined);

    const patchRes = await fetch(`${srv.baseUrl}/api/tokens/${created.record.id}`, {
      method: "PATCH",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify({ enabled: false, name: "My Paused Agent" }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as any;
    assert.equal(patched.record.enabled, false);
    assert.equal(patched.record.name, "My Paused Agent");

    const revokeRes = await fetch(`${srv.baseUrl}/api/tokens/${created.record.id}/revoke`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "X-Requested-With": "fetch" },
    });
    assert.equal(revokeRes.status, 200);

    // Settings toggle
    const settingsRes = await fetch(`${srv.baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify({ sendKillSwitch: true, legacyTokenDisabled: true }),
    });
    assert.equal(settingsRes.status, 200);
    const settingsData = (await settingsRes.json()) as any;
    assert.equal(settingsData.sendKillSwitch, true);
    assert.equal(settingsData.legacyTokenDisabled, true);
    assert.equal(settingsData.legacyTokenActive, false);

    // Audit log captured admin events
    const auditRes = await fetch(`${srv.baseUrl}/api/audit`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(auditRes.status, 200);
    const auditData = (await auditRes.json()) as any;
    assert.ok(auditData.total >= 5);
    assert.ok(auditData.logs.some((l: any) => l.toolName === "admin:token_create"));

    // Delete token
    const delRes = await fetch(`${srv.baseUrl}/api/tokens/${created.record.id}`, {
      method: "DELETE",
      headers: { Cookie: cookieHeader, "X-Requested-With": "fetch" },
    });
    assert.equal(delRes.status, 200);

    // Logout requires CSRF and clears cookie
    const logoutFail = await fetch(`${srv.baseUrl}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader },
    });
    assert.equal(logoutFail.status, 403);

    const logoutOk = await fetch(`${srv.baseUrl}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "X-Requested-With": "fetch" },
    });
    assert.equal(logoutOk.status, 200);
    assert.match(logoutOk.headers.get("set-cookie") || "", /Max-Age=0/i);
  } finally {
    await srv.close();
  }
});
