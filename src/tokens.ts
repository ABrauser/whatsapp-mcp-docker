import crypto from "node:crypto";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import { getDb, STATUS_BROADCAST_JID } from "./database.ts";

export const READ_TOOLS = [
  "search_contacts",
  "list_messages",
  "list_recent_messages",
  "list_chats",
  "get_chat",
  "get_message_context",
  "search_messages",
] as const;

export const WRITE_TOOLS = ["send_message", "edit_message"] as const;

export const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS] as const;

export type McpToolName = (typeof ALL_TOOLS)[number];

export const TOKEN_PRESETS = [
  "read_all",
  "read_chats",
  "read_send_chats",
  "full",
  "custom",
] as const;

export type TokenPreset = (typeof TOKEN_PRESETS)[number];

export type AuditStatus = "ok" | "denied" | "error" | "rate_limited";

export interface TokenRecord {
  id: string;
  name: string;
  description: string | null;
  tokenPrefix: string;
  preset: TokenPreset;
  allowedTools: McpToolName[];
  allowedChats: string[] | null;
  maxReqPerMin: number | null;
  maxSendsPerHour: number | null;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  requestCount: number;
  isExpired: boolean;
}

export interface TokenPrincipal {
  id: string;
  name: string;
  allowedTools: Set<McpToolName>;
  allowedChats: string[] | null;
  maxReqPerMin: number | null;
  maxSendsPerHour: number | null;
  isLegacy: boolean;
}

export type AuthResult =
  | { ok: true; principal: TokenPrincipal }
  | {
      ok: false;
      reason: "token_invalid" | "token_revoked" | "token_disabled" | "token_expired";
      tokenId?: string;
      tokenName?: string;
    };

export interface CreateTokenInput {
  name: string;
  description?: string | null;
  preset?: TokenPreset;
  allowedTools?: string[];
  allowedChats?: string[] | null;
  maxReqPerMin?: number | null;
  maxSendsPerHour?: number | null;
  expiresAt?: string | null;
  ttlHours?: number | null;
}

export interface UpdateTokenInput {
  name?: string;
  description?: string | null;
  preset?: TokenPreset;
  allowedTools?: string[];
  allowedChats?: string[] | null;
  maxReqPerMin?: number | null;
  maxSendsPerHour?: number | null;
  enabled?: boolean;
  expiresAt?: string | null;
}

export interface AuditLogEntry {
  id: number;
  timestamp: string;
  tokenId: string | null;
  tokenName: string | null;
  clientIp: string | null;
  toolName: string;
  targetJid: string | null;
  status: AuditStatus;
  summary: string | null;
}

export interface DashboardStats {
  totalTokens: number;
  activeTokens: number;
  chatsCount: number;
  messagesCount: number;
  calls24h: number;
}

const VALID_TOOLS_SET = new Set<string>(ALL_TOOLS);
const VALID_PRESETS_SET = new Set<string>(TOKEN_PRESETS);

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export function generateRawToken(): string {
  return `wamcp_${crypto.randomBytes(32).toString("base64url")}`;
}

export function normalizeChatJid(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.includes("@")) return null;
  if (trimmed === STATUS_BROADCAST_JID) return STATUS_BROADCAST_JID;
  const normalized = jidNormalizedUser(trimmed);
  return normalized && normalized.includes("@") ? normalized : null;
}

export function normalizeAllowedChats(chats: string[] | null | undefined): string[] | null {
  if (chats === null || chats === undefined) return null;
  const deduped = new Set<string>();
  for (const jid of chats) {
    if (typeof jid !== "string") continue;
    const norm = normalizeChatJid(jid);
    if (norm) deduped.add(norm);
  }
  return [...deduped];
}

export function sanitizeToolList(tools: readonly string[]): McpToolName[] {
  const deduped = new Set<McpToolName>();
  for (const t of tools) {
    if (VALID_TOOLS_SET.has(t)) {
      deduped.add(t as McpToolName);
    }
  }
  return [...deduped];
}

export function getPresetTools(preset: TokenPreset): McpToolName[] {
  switch (preset) {
    case "read_all":
    case "read_chats":
      return [...READ_TOOLS];
    case "read_send_chats":
      return [...READ_TOOLS, "send_message"];
    case "full":
      return [...ALL_TOOLS];
    case "custom":
      return [...READ_TOOLS];
  }
}

export function resolvePresetAndTools(
  preset: string | undefined,
  explicitTools: string[] | undefined,
): { preset: TokenPreset; allowedTools: McpToolName[] } {
  const validPreset: TokenPreset =
    preset && VALID_PRESETS_SET.has(preset) ? (preset as TokenPreset) : "custom";

  if (validPreset === "custom") {
    const tools = explicitTools ? sanitizeToolList(explicitTools) : getPresetTools("custom");
    return { preset: "custom", allowedTools: tools };
  }

  if (explicitTools && explicitTools.length > 0) {
    return { preset: validPreset, allowedTools: sanitizeToolList(explicitTools) };
  }

  return { preset: validPreset, allowedTools: getPresetTools(validPreset) };
}

function parseJsonStringArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // ignore malformed JSON
  }
  return null;
}

function rowToTokenRecord(row: any): TokenRecord {
  const tools = sanitizeToolList(parseJsonStringArray(row.allowed_tools) ?? []);
  const chats = row.allowed_chats === null ? null : (parseJsonStringArray(row.allowed_chats) ?? []);
  const expiresAt: string | null = row.expires_at ?? null;
  const isExpired = expiresAt !== null && Date.parse(expiresAt) <= Date.now();
  const preset: TokenPreset = VALID_PRESETS_SET.has(row.preset)
    ? (row.preset as TokenPreset)
    : "custom";

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    tokenPrefix: row.token_prefix,
    preset,
    allowedTools: tools,
    allowedChats: chats,
    maxReqPerMin: row.max_req_per_min ?? null,
    maxSendsPerHour: row.max_sends_per_hour ?? null,
    enabled: Boolean(row.enabled),
    expiresAt,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    lastUsedIp: row.last_used_ip ?? null,
    requestCount: Number(row.request_count ?? 0),
    isExpired,
  };
}

function computeExpiresAt(
  expiresAt?: string | null,
  ttlHours?: number | null,
): string | null {
  if (typeof ttlHours === "number" && Number.isFinite(ttlHours) && ttlHours > 0) {
    return new Date(Date.now() + ttlHours * 3600_000).toISOString();
  }
  if (expiresAt) {
    const ms = Date.parse(expiresAt);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

export function createApiToken(input: CreateTokenInput): {
  rawToken: string;
  record: TokenRecord;
} {
  const db = getDb();
  const name = input.name.trim();
  if (!name) {
    throw new Error("Token name must not be empty.");
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 12);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const { preset, allowedTools } = resolvePresetAndTools(input.preset, input.allowedTools);
  if (allowedTools.length === 0) {
    throw new Error("Token must grant at least one tool.");
  }

  const normalizedChats = normalizeAllowedChats(input.allowedChats);
  const expiresAt = computeExpiresAt(input.expiresAt, input.ttlHours);

  const maxReqPerMin =
    typeof input.maxReqPerMin === "number" && Number.isFinite(input.maxReqPerMin) && input.maxReqPerMin > 0
      ? Math.floor(input.maxReqPerMin)
      : null;
  const maxSendsPerHour =
    typeof input.maxSendsPerHour === "number" && Number.isFinite(input.maxSendsPerHour) && input.maxSendsPerHour > 0
      ? Math.floor(input.maxSendsPerHour)
      : null;

  db.prepare(`
    INSERT INTO api_tokens (
      id, name, description, token_prefix, token_hash, preset,
      allowed_tools, allowed_chats, max_req_per_min, max_sends_per_hour,
      enabled, expires_at, created_at, revoked_at, last_used_at, last_used_ip, request_count
    ) VALUES (
      @id, @name, @description, @token_prefix, @token_hash, @preset,
      @allowed_tools, @allowed_chats, @max_req_per_min, @max_sends_per_hour,
      1, @expires_at, @created_at, NULL, NULL, NULL, 0
    )
  `).run({
    id,
    name,
    description: input.description?.trim() || null,
    token_prefix: tokenPrefix,
    token_hash: tokenHash,
    preset,
    allowed_tools: JSON.stringify(allowedTools),
    allowed_chats: normalizedChats === null ? null : JSON.stringify(normalizedChats),
    max_req_per_min: maxReqPerMin,
    max_sends_per_hour: maxSendsPerHour,
    expires_at: expiresAt,
    created_at: now,
  });

  const record = getApiTokenById(id);
  if (!record) {
    throw new Error("Failed to read back created token.");
  }
  return { rawToken, record };
}

export function listApiTokens(): TokenRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM api_tokens ORDER BY created_at DESC`)
    .all() as any[];
  return rows.map(rowToTokenRecord);
}

export function getApiTokenById(id: string): TokenRecord | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM api_tokens WHERE id = ?`).get(id) as any | undefined;
  return row ? rowToTokenRecord(row) : null;
}

export function updateApiToken(id: string, patch: UpdateTokenInput): TokenRecord | null {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM api_tokens WHERE id = ?`).get(id) as any | undefined;
  if (!existing) return null;

  const current = rowToTokenRecord(existing);

  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!name) {
    throw new Error("Token name must not be empty.");
  }

  const description =
    patch.description !== undefined
      ? (patch.description?.trim() || null)
      : current.description;

  const preset: TokenPreset =
    patch.preset && VALID_PRESETS_SET.has(patch.preset)
      ? (patch.preset as TokenPreset)
      : current.preset;

  const allowedTools =
    patch.allowedTools !== undefined
      ? sanitizeToolList(patch.allowedTools)
      : patch.preset !== undefined && patch.preset !== "custom"
        ? getPresetTools(preset)
        : current.allowedTools;

  if (allowedTools.length === 0) {
    throw new Error("Token must grant at least one tool.");
  }

  const allowedChats =
    patch.allowedChats !== undefined
      ? normalizeAllowedChats(patch.allowedChats)
      : current.allowedChats;

  const maxReqPerMin =
    patch.maxReqPerMin !== undefined
      ? (typeof patch.maxReqPerMin === "number" && Number.isFinite(patch.maxReqPerMin) && patch.maxReqPerMin > 0
          ? Math.floor(patch.maxReqPerMin)
          : null)
      : current.maxReqPerMin;

  const maxSendsPerHour =
    patch.maxSendsPerHour !== undefined
      ? (typeof patch.maxSendsPerHour === "number" && Number.isFinite(patch.maxSendsPerHour) && patch.maxSendsPerHour > 0
          ? Math.floor(patch.maxSendsPerHour)
          : null)
      : current.maxSendsPerHour;

  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0);

  let expiresAt = current.expiresAt;
  if (patch.expiresAt !== undefined) {
    expiresAt = computeExpiresAt(patch.expiresAt, null);
  }

  db.prepare(`
    UPDATE api_tokens
    SET name = @name,
        description = @description,
        preset = @preset,
        allowed_tools = @allowed_tools,
        allowed_chats = @allowed_chats,
        max_req_per_min = @max_req_per_min,
        max_sends_per_hour = @max_sends_per_hour,
        enabled = @enabled,
        expires_at = @expires_at
    WHERE id = @id
  `).run({
    id,
    name,
    description,
    preset,
    allowed_tools: JSON.stringify(allowedTools),
    allowed_chats: allowedChats === null ? null : JSON.stringify(allowedChats),
    max_req_per_min: maxReqPerMin,
    max_sends_per_hour: maxSendsPerHour,
    enabled,
    expires_at: expiresAt,
  });

  return getApiTokenById(id);
}

export function revokeApiToken(id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?), enabled = 0 WHERE id = ?`)
    .run(now, id);
  return (result.changes ?? 0) > 0;
}

export function deleteApiToken(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM api_tokens WHERE id = ?`).run(id);
  return (result.changes ?? 0) > 0;
}

export function countActiveApiTokens(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM api_tokens
       WHERE enabled = 1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(now) as { cnt: number };
  return Number(row?.cnt ?? 0);
}

export function getSetting(key: string, defaultValue: string | null = null): string | null {
  const db = getDb();
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, now);
}

export function isSendKillSwitchActive(): boolean {
  return getSetting("send_kill_switch", "false") === "true";
}

export function setSendKillSwitch(active: boolean): void {
  setSetting("send_kill_switch", active ? "true" : "false");
}

export function isLegacyTokenDisabled(): boolean {
  if (process.env.MCP_DISABLE_LEGACY_TOKEN === "true") return true;
  return getSetting("legacy_token_disabled", "false") === "true";
}

export function setLegacyTokenDisabled(disabled: boolean): void {
  setSetting("legacy_token_disabled", disabled ? "true" : "false");
}

export function getOrCreateAdminSessionSecret(): string {
  const existing = getSetting("admin_session_secret", null);
  if (existing && existing.length >= 32) return existing;

  const db = getDb();
  const secret = crypto.randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value, updated_at)
    VALUES ('admin_session_secret', ?, ?)
  `).run(secret, now);

  return getSetting("admin_session_secret", secret) ?? secret;
}

export function isLegacyEnvTokenActive(): boolean {
  const envToken = process.env.MCP_AUTH_TOKEN?.trim();
  if (!envToken) return false;
  return !isLegacyTokenDisabled();
}

export function authenticateBearerToken(
  rawToken: string,
  clientIp?: string | null,
): AuthResult {
  if (!rawToken) {
    return { ok: false, reason: "token_invalid" };
  }

  const db = getDb();
  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare(`SELECT * FROM api_tokens WHERE token_hash = ?`)
    .get(tokenHash) as any | undefined;

  if (row) {
    const hashMatches = timingSafeEqualStrings(row.token_hash, tokenHash);
    if (!hashMatches) {
      return { ok: false, reason: "token_invalid" };
    }
    if (row.revoked_at) {
      return { ok: false, reason: "token_revoked", tokenId: row.id, tokenName: row.name };
    }
    if (!row.enabled) {
      return { ok: false, reason: "token_disabled", tokenId: row.id, tokenName: row.name };
    }
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      return { ok: false, reason: "token_expired", tokenId: row.id, tokenName: row.name };
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE api_tokens
      SET last_used_at = ?,
          last_used_ip = ?,
          request_count = request_count + 1
      WHERE id = ?
    `).run(now, clientIp ?? null, row.id);

    const record = rowToTokenRecord(row);
    return {
      ok: true,
      principal: {
        id: record.id,
        name: record.name,
        allowedTools: new Set<McpToolName>(record.allowedTools),
        allowedChats: record.allowedChats,
        maxReqPerMin: record.maxReqPerMin,
        maxSendsPerHour: record.maxSendsPerHour,
        isLegacy: false,
      },
    };
  }

  const envToken = process.env.MCP_AUTH_TOKEN?.trim();
  if (
    envToken &&
    process.env.MCP_DISABLE_LEGACY_TOKEN !== "true" &&
    !isLegacyTokenDisabled() &&
    timingSafeEqualStrings(rawToken, envToken)
  ) {
    return {
      ok: true,
      principal: {
        id: "legacy-env",
        name: "MCP_AUTH_TOKEN (Legacy)",
        allowedTools: new Set<McpToolName>(ALL_TOOLS),
        allowedChats: null,
        maxReqPerMin: null,
        maxSendsPerHour: null,
        isLegacy: true,
      },
    };
  }

  return { ok: false, reason: "token_invalid" };
}

/**
 * Expand a token's `allowedChats` list with bidirectional `@lid` ↔ `@s.whatsapp.net`
 * aliases from `lid_aliases` so selecting a contact by either identifier also grants
 * access to historical messages stored under the paired form.
 */
export function expandAllowedChats(allowedChats: string[] | null): Set<string> | null {
  if (allowedChats === null) return null;
  const set = new Set<string>();
  for (const raw of allowedChats) {
    const norm = normalizeChatJid(raw);
    if (norm) set.add(norm);
  }
  if (set.size === 0) return set;

  try {
    const db = getDb();
    const initial = [...set];
    const placeholders = initial.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT lid_jid, s_jid FROM lid_aliases
         WHERE lid_jid IN (${placeholders}) OR s_jid IN (${placeholders})`,
      )
      .all(...initial, ...initial) as { lid_jid: string; s_jid: string }[];

    for (const r of rows) {
      const lid = normalizeChatJid(r.lid_jid);
      const s = normalizeChatJid(r.s_jid);
      if (lid) set.add(lid);
      if (s) set.add(s);
    }

    // Also expand via contacts.phone_number for @lid <-> @s.whatsapp.net pairs
    // that haven't produced a lid_aliases row yet.
    const lidJids = [...set].filter((j) => j.endsWith("@lid"));
    if (lidJids.length > 0) {
      const lidPh = lidJids.map(() => "?").join(", ");
      const phoneRows = db
        .prepare(
          `SELECT phone_number FROM contacts
           WHERE jid IN (${lidPh}) AND phone_number IS NOT NULL AND TRIM(phone_number) != ''`,
        )
        .all(...lidJids) as { phone_number: string }[];
      for (const r of phoneRows) {
        const cleanDigits = r.phone_number.replace(/[^0-9]/g, "");
        if (cleanDigits) {
          const sJid = normalizeChatJid(`${cleanDigits}@s.whatsapp.net`);
          if (sJid) set.add(sJid);
        }
      }
    }

    const phones = new Set<string>();
    for (const jid of set) {
      const m = jid.match(/^(\d+)@s\.whatsapp\.net$/);
      if (m) phones.add(m[1]);
    }
    if (phones.size > 0) {
      const phoneList = [...phones];
      const phonePh = phoneList.map(() => "?").join(", ");
      const lidRows = db
        .prepare(
          `SELECT jid FROM contacts
           WHERE jid LIKE '%@lid' AND phone_number IN (${phonePh})`,
        )
        .all(...phoneList) as { jid: string }[];
      for (const r of lidRows) {
        const lid = normalizeChatJid(r.jid);
        if (lid) set.add(lid);
      }
    }
  } catch {
    // lid_aliases/contacts may not exist in isolated unit test DBs without migrations
  }

  return set;
}

export function recordAuditLog(entry: {
  tokenId?: string | null;
  tokenName?: string | null;
  clientIp?: string | null;
  toolName: string;
  targetJid?: string | null;
  status: AuditStatus;
  summary?: string | null;
}): void {
  try {
    const db = getDb();
    const truncatedSummary =
      entry.summary !== undefined && entry.summary !== null
        ? String(entry.summary).slice(0, 200)
        : null;
    db.prepare(`
      INSERT INTO audit_logs (
        timestamp, token_id, token_name, client_ip, tool_name, target_jid, status, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      entry.tokenId ?? null,
      entry.tokenName ?? null,
      entry.clientIp ?? null,
      entry.toolName,
      entry.targetJid ?? null,
      entry.status,
      truncatedSummary,
    );
  } catch {
    // Never break MCP/admin requests if audit logging fails
  }
}

export function listAuditLogs(filter?: {
  limit?: number;
  offset?: number;
  tokenId?: string | null;
  toolName?: string | null;
  status?: string | null;
}): { logs: AuditLogEntry[]; total: number } {
  const db = getDb();
  const rawLimit = filter?.limit ?? 100;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 500);
  const offset = Math.max(0, Math.floor(filter?.offset ?? 0));

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter?.tokenId) {
    clauses.push(`token_id = ?`);
    params.push(filter.tokenId);
  }
  if (filter?.toolName) {
    clauses.push(`tool_name = ?`);
    params.push(filter.toolName);
  }
  if (filter?.status) {
    clauses.push(`status = ?`);
    params.push(filter.status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM audit_logs ${where}`)
    .get(...params) as { cnt: number };

  const rows = db
    .prepare(
      `SELECT id, timestamp, token_id, token_name, client_ip, tool_name, target_jid, status, summary
       FROM audit_logs ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as any[];

  return {
    logs: rows.map((r) => ({
      id: Number(r.id),
      timestamp: r.timestamp,
      tokenId: r.token_id ?? null,
      tokenName: r.token_name ?? null,
      clientIp: r.client_ip ?? null,
      toolName: r.tool_name,
      targetJid: r.target_jid ?? null,
      status: r.status as AuditStatus,
      summary: r.summary ?? null,
    })),
    total: Number(countRow?.cnt ?? 0),
  };
}

export function pruneAuditLogs(retentionDays: number = 30, maxRows: number = 50_000): number {
  const db = getDb();
  let deleted = 0;
  try {
    if (retentionDays > 0) {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      const res = db
        .prepare(`DELETE FROM audit_logs WHERE timestamp < ?`)
        .run(cutoff);
      deleted += Number(res.changes ?? 0);
    }

    if (maxRows > 0) {
      const row = db.prepare(`SELECT COUNT(*) AS cnt FROM audit_logs`).get() as { cnt: number };
      if (Number(row?.cnt ?? 0) > maxRows) {
        const res = db
          .prepare(
            `DELETE FROM audit_logs
             WHERE id NOT IN (SELECT id FROM audit_logs ORDER BY id DESC LIMIT ?)`,
          )
          .run(maxRows);
        deleted += Number(res.changes ?? 0);
      }
    }
  } catch {
    // ignore cleanup failures
  }
  return deleted;
}

export function countRecentSends(tokenId: string, windowMs: number = 3_600_000): number {
  const db = getDb();
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM audit_logs
       WHERE token_id = ?
         AND status = 'ok'
         AND tool_name IN ('send_message', 'edit_message')
         AND timestamp >= ?`,
    )
    .get(tokenId, sinceIso) as { cnt: number };
  return Number(row?.cnt ?? 0);
}

export function getDashboardStats(): DashboardStats {
  const db = getDb();
  const now = new Date().toISOString();
  const since24h = new Date(Date.now() - 86_400_000).toISOString();

  const totalTokens = Number(
    (db.prepare(`SELECT COUNT(*) AS cnt FROM api_tokens`).get() as { cnt: number })?.cnt ?? 0,
  );
  const activeTokens = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM api_tokens
           WHERE enabled = 1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(now) as { cnt: number }
    )?.cnt ?? 0,
  );
  const chatsCount = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS cnt FROM chats WHERE jid != ?`)
        .get(STATUS_BROADCAST_JID) as { cnt: number }
    )?.cnt ?? 0,
  );
  const messagesCount = Number(
    (db.prepare(`SELECT COUNT(*) AS cnt FROM messages`).get() as { cnt: number })?.cnt ?? 0,
  );
  const calls24h = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS cnt FROM audit_logs WHERE timestamp >= ?`)
        .get(since24h) as { cnt: number }
    )?.cnt ?? 0,
  );

  return {
    totalTokens,
    activeTokens,
    chatsCount,
    messagesCount,
    calls24h,
  };
}
