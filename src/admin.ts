import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Server } from "node:http";
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { renderSVG } from "uqr";
import { z } from "zod";
import type { Logger } from "pino";

import { getDb, searchChatsAndContactsForPicker } from "./database.ts";
import { getOverride, listOverrides } from "./contactOverrides.ts";
import { resolveByPushName } from "./contactResolver.ts";
import type { WhatsAppConnection } from "./whatsapp.ts";
import {
  ALL_TOOLS,
  TOKEN_PRESETS,
  createApiToken,
  deleteApiToken,
  getApiTokenById,
  getDashboardStats,
  getOrCreateAdminSessionSecret,
  isLegacyEnvTokenActive,
  isLegacyTokenDisabled,
  isSendKillSwitchActive,
  listApiTokens,
  listAuditLogs,
  normalizeChatJid,
  recordAuditLog,
  revokeApiToken,
  setLegacyTokenDisabled,
  setSendKillSwitch,
  timingSafeEqualStrings,
  updateApiToken,
} from "./tokens.ts";

const SESSION_COOKIE_NAME = "wamcp_admin_session";
const SESSION_TTL_SECONDS = 12 * 3600;

export interface StartAdminOptions {
  adminPort: number;
  adminBind: string;
  mcpPort: number;
  adminPassword?: string | null;
  quiet?: boolean;
}

interface SessionPayload {
  exp: number;
  nonce: string;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function deriveSigningKey(adminPassword: string): Buffer {
  const secret = getOrCreateAdminSessionSecret();
  return crypto
    .createHash("sha256")
    .update(`${secret}:${adminPassword}`, "utf8")
    .digest();
}

function signSessionToken(adminPassword: string): string {
  const payload: SessionPayload = {
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", deriveSigningKey(adminPassword))
    .update(payloadB64, "utf8")
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token: string | undefined, adminPassword: string): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!payloadB64 || !sigB64) return false;

  const expectedSig = crypto
    .createHmac("sha256", deriveSigningKey(adminPassword))
    .update(payloadB64, "utf8")
    .digest();

  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(sigB64, "base64url");
  } catch {
    return false;
  }
  if (actualSig.length !== expectedSig.length) return false;
  if (!crypto.timingSafeEqual(actualSig, expectedSig)) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SessionPayload;
    return typeof decoded.exp === "number" && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

function formatSessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

const createTokenSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500).nullable().optional(),
  preset: z.enum(TOKEN_PRESETS).optional().default("read_all"),
  allowedTools: z.array(z.enum(ALL_TOOLS)).optional(),
  allowedChats: z.array(z.string().trim().min(1)).nullable().optional(),
  ttlHours: z.number().positive().max(87_600).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  maxReqPerMin: z.number().int().positive().max(10_000).nullable().optional(),
  maxSendsPerHour: z.number().int().positive().max(10_000).nullable().optional(),
});

const updateTokenSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  preset: z.enum(TOKEN_PRESETS).optional(),
  allowedTools: z.array(z.enum(ALL_TOOLS)).min(1).optional(),
  allowedChats: z.array(z.string().trim().min(1)).nullable().optional(),
  ttlHours: z.number().positive().max(87_600).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  maxReqPerMin: z.number().int().positive().max(10_000).nullable().optional(),
  maxSendsPerHour: z.number().int().positive().max(10_000).nullable().optional(),
  enabled: z.boolean().optional(),
});

const settingsSchema = z.object({
  sendKillSwitch: z.boolean().optional(),
  legacyTokenDisabled: z.boolean().optional(),
});

function validateChatList(
  chats: string[] | null | undefined,
): { ok: true; value: string[] | null | undefined } | { ok: false; invalid: string } {
  if (chats === null || chats === undefined) {
    return { ok: true, value: chats };
  }
  const normalized: string[] = [];
  for (const raw of chats) {
    const jid = normalizeChatJid(raw);
    if (!jid) return { ok: false, invalid: raw };
    normalized.push(jid);
  }
  return { ok: true, value: normalized };
}

export async function startAdminServer(
  connection: WhatsAppConnection | null,
  mcpLogger: Logger,
  opts: StartAdminOptions,
): Promise<{ httpServer: Server; port: number }> {
  const app = express();

  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    if (trustProxy === "true") app.set("trust proxy", true);
    else if (trustProxy === "false") app.set("trust proxy", false);
    else if (/^\d+$/.test(trustProxy)) app.set("trust proxy", Number.parseInt(trustProxy, 10));
    else app.set("trust proxy", trustProxy);
  }

  // Security headers on all Admin UI & API responses.
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use(express.json({ limit: "256kb" }));

  const htmlPath = path.join(import.meta.dirname, "admin", "index.html");
  let cachedHtml: string | null = null;
  const loadHtml = () => {
    if (!cachedHtml || process.env.NODE_ENV !== "production") {
      cachedHtml = fs.readFileSync(htmlPath, "utf8");
    }
    return cachedHtml;
  };

  const getAdminPassword = (): string | null => {
    if (opts.adminPassword !== undefined) {
      return opts.adminPassword?.trim() || null;
    }
    return process.env.MCP_ADMIN_PASSWORD?.trim() || null;
  };

  const isAuthenticated = (req: Request, adminPassword: string | null): boolean => {
    if (!adminPassword) return false;
    const cookies = parseCookies(req.header("cookie"));
    return verifySessionToken(cookies[SESSION_COOKIE_NAME], adminPassword);
  };

  const requireAdminConfigured = (_req: Request, res: Response, next: () => void) => {
    if (!getAdminPassword()) {
      res.status(503).json({
        error: "Admin UI disabled: MCP_ADMIN_PASSWORD is not configured.",
      });
      return;
    }
    next();
  };

  const requireAdminAuth = (req: Request, res: Response, next: () => void) => {
    const pw = getAdminPassword();
    if (!pw) {
      res.status(503).json({
        error: "Admin UI disabled: MCP_ADMIN_PASSWORD is not configured.",
      });
      return;
    }
    if (!isAuthenticated(req, pw)) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  };

  const requireCsrf = (req: Request, res: Response, next: () => void) => {
    if (req.header("x-requested-with") !== "fetch") {
      res.status(403).json({ error: "Missing or invalid X-Requested-With header" });
      return;
    }
    next();
  };

  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => {
      mcpLogger.warn(`Admin login rate limit exceeded from ${req.ip}`);
      res.status(429).json({
        error: "Too many failed login attempts. Please wait 15 minutes.",
      });
    },
  });

  // ─── UI Page ────────────────────────────────────────────────────────
  app.get("/", (_req: Request, res: Response) => {
    try {
      res.type("html").send(loadHtml());
    } catch (err: any) {
      mcpLogger.error(`Failed to serve Admin UI HTML: ${err.message}`);
      res.status(500).send("Admin UI HTML missing.");
    }
  });

  // ─── Auth Routes ────────────────────────────────────────────────────
  app.get("/api/auth/status", (req: Request, res: Response) => {
    const pw = getAdminPassword();
    res.json({
      configured: Boolean(pw),
      authenticated: isAuthenticated(req, pw),
    });
  });

  app.post("/api/login", loginLimiter, requireAdminConfigured, (req: Request, res: Response) => {
    const pw = getAdminPassword()!;
    const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Password is required" });
      return;
    }

    if (!timingSafeEqualStrings(parsed.data.password, pw)) {
      mcpLogger.warn(`Failed Admin UI login attempt from ${req.ip}`);
      recordAuditLog({
        tokenId: "admin",
        tokenName: "Admin UI",
        clientIp: req.ip ?? null,
        toolName: "admin:login",
        status: "denied",
        summary: "Invalid password",
      });
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    const sessionToken = signSessionToken(pw);
    res.setHeader("Set-Cookie", formatSessionCookie(sessionToken, SESSION_TTL_SECONDS, req.secure));
    recordAuditLog({
      tokenId: "admin",
      tokenName: "Admin UI",
      clientIp: req.ip ?? null,
      toolName: "admin:login",
      status: "ok",
      summary: "Admin session started",
    });
    res.json({ ok: true });
  });

  app.post("/api/logout", requireCsrf, (req: Request, res: Response) => {
    res.setHeader("Set-Cookie", formatSessionCookie("", 0, req.secure));
    res.json({ ok: true });
  });

  // ─── Status & QR Pairing ────────────────────────────────────────────
  app.get("/api/status", requireAdminAuth, (_req: Request, res: Response) => {
    const connected = !!(connection && connection.sock && connection.sock.user);
    const waUser = connection?.sock?.user?.name || connection?.sock?.user?.id || null;
    const qrSvg =
      !connected && connection?.latestQr
        ? renderSVG(connection.latestQr, { border: 2, pixelSize: 6 })
        : null;

    res.json({
      whatsappConnected: connected,
      whatsappUser: waUser,
      qrSvg,
      uptimeSeconds: Math.floor(process.uptime()),
      mcpPort: opts.mcpPort,
      legacyTokenConfigured: Boolean(process.env.MCP_AUTH_TOKEN?.trim()),
      legacyTokenDisabled: isLegacyTokenDisabled(),
      legacyTokenActive: isLegacyEnvTokenActive(),
      sendKillSwitch: isSendKillSwitchActive(),
      stats: getDashboardStats(),
    });
  });

  // ─── Chat / Person Picker List ──────────────────────────────────────
  app.get("/api/chats", requireAdminAuth, (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
    const rawType = typeof req.query.type === "string" ? req.query.type.trim() : "all";
    const type: "all" | "person" | "group" =
      rawType === "person" || rawType === "group" ? rawType : "all";
    const rawLimit = Number.parseInt(String(req.query.limit ?? "150"), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 300) : 150;

    const db = getDb();
    const entries = searchChatsAndContactsForPicker({
      query: q || null,
      type,
      limit,
    });

    const formatted = entries.map((entry) => {
      const override = getOverride(entry.jid);
      const fuzzy =
        !override && !entry.isGroup && entry.name
          ? resolveByPushName(entry.name, db)?.name ?? null
          : null;
      return {
        jid: entry.jid,
        name: override ?? fuzzy ?? entry.name ?? entry.jid.split("@")[0] ?? entry.jid,
        isGroup: entry.isGroup,
        isContactOnly: entry.isContactOnly,
        lastMessageTime: entry.lastMessageTime ? entry.lastMessageTime.toISOString() : null,
      };
    });

    if (q) {
      const qLower = q.toLowerCase();
      const existingJids = new Set(formatted.map((f) => f.jid));
      const overrideMatches: typeof formatted = [];
      for (const [jid, displayName] of Object.entries(listOverrides())) {
        if (existingJids.has(jid)) continue;
        const isGroup = jid.endsWith("@g.us");
        if (type === "group" && !isGroup) continue;
        if (type === "person" && isGroup) continue;
        if (
          displayName.toLowerCase().includes(qLower) ||
          jid.toLowerCase().includes(qLower)
        ) {
          existingJids.add(jid);
          overrideMatches.push({
            jid,
            name: displayName,
            isGroup,
            isContactOnly: true,
            lastMessageTime: null,
          });
        }
      }
      if (overrideMatches.length > 0) {
        formatted.unshift(...overrideMatches);
        if (formatted.length > limit) {
          formatted.length = limit;
        }
      }
    }

    res.json({ chats: formatted });
  });

  // ─── Token CRUD ─────────────────────────────────────────────────────
  app.get("/api/tokens", requireAdminAuth, (_req: Request, res: Response) => {
    res.json({ tokens: listApiTokens() });
  });

  app.post("/api/tokens", requireAdminAuth, requireCsrf, (req: Request, res: Response) => {
    const parsed = createTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
      return;
    }

    const chatCheck = validateChatList(parsed.data.allowedChats);
    if (!chatCheck.ok) {
      res.status(400).json({ error: `Invalid JID in allowedChats: "${chatCheck.invalid}"` });
      return;
    }

    try {
      const { rawToken, record } = createApiToken({
        ...parsed.data,
        allowedChats: chatCheck.value,
      });
      recordAuditLog({
        tokenId: "admin",
        tokenName: "Admin UI",
        clientIp: req.ip ?? null,
        toolName: "admin:token_create",
        status: "ok",
        summary: `Created "${record.name}" (${record.tokenPrefix}…) preset=${record.preset}`,
      });
      res.status(201).json({ token: rawToken, record });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch("/api/tokens/:id", requireAdminAuth, requireCsrf, (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const parsed = updateTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
      return;
    }

    const chatCheck = validateChatList(parsed.data.allowedChats);
    if (!chatCheck.ok) {
      res.status(400).json({ error: `Invalid JID in allowedChats: "${chatCheck.invalid}"` });
      return;
    }

    let expiresAt = parsed.data.expiresAt;
    if (typeof parsed.data.ttlHours === "number") {
      expiresAt = new Date(Date.now() + parsed.data.ttlHours * 3600_000).toISOString();
    }

    try {
      const updated = updateApiToken(id, {
        ...parsed.data,
        allowedChats: chatCheck.value,
        expiresAt,
      });
      if (!updated) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      recordAuditLog({
        tokenId: "admin",
        tokenName: "Admin UI",
        clientIp: req.ip ?? null,
        toolName: "admin:token_update",
        status: "ok",
        summary: `Updated "${updated.name}" (enabled=${updated.enabled})`,
      });
      res.json({ record: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tokens/:id/revoke", requireAdminAuth, requireCsrf, (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const existing = getApiTokenById(id);
    if (!existing) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    revokeApiToken(id);
    recordAuditLog({
      tokenId: "admin",
      tokenName: "Admin UI",
      clientIp: req.ip ?? null,
      toolName: "admin:token_revoke",
      status: "ok",
      summary: `Revoked "${existing.name}" (${existing.tokenPrefix}…)`,
    });
    res.json({ ok: true });
  });

  app.delete("/api/tokens/:id", requireAdminAuth, requireCsrf, (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const existing = getApiTokenById(id);
    if (!existing) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    deleteApiToken(id);
    recordAuditLog({
      tokenId: "admin",
      tokenName: "Admin UI",
      clientIp: req.ip ?? null,
      toolName: "admin:token_delete",
      status: "ok",
      summary: `Deleted "${existing.name}" (${existing.tokenPrefix}…)`,
    });
    res.json({ ok: true });
  });

  // ─── Audit Log ──────────────────────────────────────────────────────
  app.get("/api/audit", requireAdminAuth, (req: Request, res: Response) => {
    const limit = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const offset = Number.parseInt(String(req.query.offset ?? "0"), 10);
    const tokenId = typeof req.query.tokenId === "string" && req.query.tokenId ? req.query.tokenId : null;
    const toolName = typeof req.query.toolName === "string" && req.query.toolName ? req.query.toolName : null;
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;

    const result = listAuditLogs({
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
      tokenId,
      toolName,
      status,
    });
    res.json(result);
  });

  // ─── Global Settings ────────────────────────────────────────────────
  app.patch("/api/settings", requireAdminAuth, requireCsrf, (req: Request, res: Response) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
      return;
    }

    const changes: string[] = [];
    if (parsed.data.sendKillSwitch !== undefined) {
      setSendKillSwitch(parsed.data.sendKillSwitch);
      changes.push(`sendKillSwitch=${parsed.data.sendKillSwitch}`);
    }
    if (parsed.data.legacyTokenDisabled !== undefined) {
      setLegacyTokenDisabled(parsed.data.legacyTokenDisabled);
      changes.push(`legacyTokenDisabled=${parsed.data.legacyTokenDisabled}`);
    }

    if (changes.length > 0) {
      recordAuditLog({
        tokenId: "admin",
        tokenName: "Admin UI",
        clientIp: req.ip ?? null,
        toolName: "admin:settings",
        status: "ok",
        summary: changes.join(", "),
      });
    }

    res.json({
      sendKillSwitch: isSendKillSwitchActive(),
      legacyTokenDisabled: isLegacyTokenDisabled(),
      legacyTokenActive: isLegacyEnvTokenActive(),
    });
  });

  // ─── Start Server ───────────────────────────────────────────────────
  return new Promise((resolve) => {
    const httpServer = app.listen(opts.adminPort, opts.adminBind, () => {
      const addr = httpServer.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : opts.adminPort;
      mcpLogger.info(`Admin UI server listening on http://${opts.adminBind}:${boundPort}`);
      if (!opts.quiet) {
        const configured = Boolean(getAdminPassword());
        console.log(
          configured
            ? `🔐 Admin UI ready at http://${opts.adminBind}:${boundPort}/`
            : `⚠️  Admin UI listening at http://${opts.adminBind}:${boundPort}/ (DISABLED until MCP_ADMIN_PASSWORD is set)`,
        );
      }
      resolve({ httpServer, port: boundPort });
    });
  });
}
