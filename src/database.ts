import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { runMigrations, APP_MIGRATIONS } from "./migrations.ts";
import { invalidateContactResolverCache } from "./contactResolver.ts";

/**
 * Resolved lazily on every getDb() so tests can swap WHATSAPP_MCP_DATA_DIR
 * after import and still hit a per-test temp directory. Using a single
 * shared default for production code paths kept the previous behavior.
 */
function getDataDir(): string {
  return process.env.WHATSAPP_MCP_DATA_DIR
    ? path.resolve(process.env.WHATSAPP_MCP_DATA_DIR)
    : path.join(import.meta.dirname, "..", "data");
}
function getDbPath(): string {
  return path.join(getDataDir(), "whatsapp.db");
}

/**
 * The synthetic chat WhatsApp uses for everyone's Status posts ("Stories").
 * It contains 24-hour ephemeral content that is conceptually separate from
 * regular 1:1 / group chats. Tools default to excluding it; callers must
 * opt in via `includeStatus: true` or by querying the JID directly.
 */
export const STATUS_BROADCAST_JID = "status@broadcast";

export interface Chat {
  jid: string;
  name?: string | null;
  last_message_time?: Date | null;
  last_message?: string | null;
  last_sender?: string | null;
  last_sender_name?: string | null;
  last_sender_push_name?: string | null;
  last_is_from_me?: boolean | null;
}

export type Message = {
  id: string;
  chat_jid: string;
  sender?: string | null;
  sender_name?: string | null;
  /**
   * The contact's WhatsApp push-name as captured from the message itself
   * (msg.pushName). Acts as a sender-display fallback when `sender` is NULL
   * — e.g. for stickers and some media where Baileys does not include
   * key.participant. Survives even if the contact row never gets created.
   */
  sender_push_name?: string | null;
  content: string;
  timestamp: Date;
  is_from_me: boolean;
  chat_name?: string | null;
};

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    const dataDir = getDataDir();
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    dbInstance = new DatabaseSync(getDbPath());
  }
  return dbInstance;
}

export function getUnnamedGroupJids(): string[] {
  try {
    const db = getDb();
    const rows = db
      .prepare(`SELECT jid FROM chats WHERE jid LIKE '%@g.us' AND (name IS NULL OR name = '')`)
      .all() as { jid: string }[];
    return rows.map((r) => r.jid);
  } catch {
    return [];
  }
}

/**
 * @deprecated Name resolution is now done via JOIN in queries (no N+1).
 * Kept for ad-hoc tooling; do not call per-row.
 */
export function getContactName(jid: string | null | undefined): string | null {
  if (!jid) return null;
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT COALESCE(name, notify, phone_number) as display_name FROM contacts WHERE jid = ?`
    ).get(jid) as { display_name: string | null } | undefined;
    return row?.display_name ?? null;
  } catch {
    return null;
  }
}

const LOG_VERBOSE = process.env.WHATSAPP_DEBUG === "true" || process.env.LOG_LEVEL === "debug";
function vlog(...args: unknown[]): void {
  if (LOG_VERBOSE) console.log(...args);
}

export function initializeDatabase(): DatabaseSync {
  const db = getDb();

  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
            jid TEXT PRIMARY KEY,
            name TEXT,
            last_message_time TEXT -- Store dates as ISO strings
        );
    `);

  db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT,
            chat_jid TEXT,
            sender TEXT,      -- JID of the sender (can be group participant or contact)
            content TEXT,
            timestamp TEXT, -- Store dates as ISO strings
            is_from_me INTEGER, -- Store booleans as 0 or 1
            PRIMARY KEY (id, chat_jid),
            FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
        );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        phone_number TEXT
      );
    `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages (chat_jid);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender);`,
  );
  // Composite index for the most common query: messages of a chat ordered by time desc.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_jid, timestamp DESC);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats (last_message_time);`,
  );

  // ── FTS5 virtual table for fast content search ──────────────────
  // Using `external content` mode keyed on (id, chat_jid) keeps storage compact
  // and lets us rebuild from messages if needed.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
    // Backfill if FTS index is empty but messages exist (first-time migration).
    const ftsCount = (db.prepare(`SELECT count(*) as n FROM messages_fts`).get() as { n: number }).n;
    const msgCount = (db.prepare(`SELECT count(*) as n FROM messages`).get() as { n: number }).n;
    if (ftsCount === 0 && msgCount > 0) {
      db.exec(`INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages;`);
      console.log(`[FTS] Backfilled ${msgCount} messages into messages_fts.`);
    }
  } catch (err) {
    console.error("FTS5 setup failed (search will fall back to LIKE):", err);
  }

  // ── Versioned data migrations ────────────────────────────────────
  // Schema-level objects above are CREATE … IF NOT EXISTS so they are run
  // every start. One-shot data transforms and ALTER TABLE statements live in
  // the migrations module and run exactly once each.
  runMigrations(db, APP_MIGRATIONS);

  // ── Resolution view (DRY) ────────────────────────────────────────
  // Single source of truth for contact name resolution. Three levels of
  // fallback for @lid contacts that lack a name: same-notify match, then
  // notify-equals-name match, then plain notify/phone/jid. The view is
  // referenced from getChats, getChat, getMessages, getRecentMessages,
  // getMessagesAround, searchMessages, searchDbForContacts so that any
  // change to resolution lives in one place only.
  // CREATE VIEW IF NOT EXISTS is idempotent. We DROP first so updates to the
  // logic apply cleanly across upgrades.
  try {
    db.exec(`DROP VIEW IF EXISTS contacts_resolved`);
    db.exec(`
      CREATE VIEW contacts_resolved AS
      SELECT
        ct.jid AS jid,
        ct.name AS name,
        ct.notify AS notify,
        ct.phone_number AS phone_number,
        COALESCE(
          -- 1. Direct saved address-book name on this row.
          ct.name,
          -- 2. For @lid rows: deterministic JOIN through lid_aliases to the
          --    @s.whatsapp.net contact whose JID was provided alongside this
          --    @lid in a Baileys message envelope (key.participantPn). This is
          --    the canonical mapping; takes precedence over notify heuristics.
          CASE WHEN ct.jid LIKE '%@lid' THEN
            (SELECT cs.name FROM lid_aliases la
              JOIN contacts cs ON cs.jid = la.s_jid
              WHERE la.lid_jid = ct.jid
                AND cs.name IS NOT NULL
                AND TRIM(cs.name) != ''
              LIMIT 1)
          END,
          -- 3. Legacy fallback: @s contact whose notify equals this @lid notify.
          CASE WHEN ct.jid LIKE '%@lid' AND ct.notify IS NOT NULL THEN
            (SELECT ct2.name FROM contacts ct2
             WHERE ct2.jid LIKE '%@s.whatsapp.net'
               AND ct2.notify = ct.notify
               AND ct2.name IS NOT NULL
             LIMIT 1)
          END,
          -- 4. Legacy fallback: @s contact whose saved name equals this @lid notify.
          CASE WHEN ct.jid LIKE '%@lid' AND ct.notify IS NOT NULL THEN
            (SELECT ct2.name FROM contacts ct2
             WHERE ct2.jid LIKE '%@s.whatsapp.net'
               AND LOWER(ct2.name) = LOWER(ct.notify)
               AND ct2.name IS NOT NULL
             LIMIT 1)
          END,
          ct.notify,
          ct.phone_number,
          ct.jid
        ) AS display_name
      FROM contacts ct;
    `);
  } catch (err) {
    console.error("Failed to create contacts_resolved view:", err);
  }

  return db;
}

/**
 * Run at runtime after contacts are updated to migrate any @lid messages
 * that can now be resolved to @s.whatsapp.net JIDs (phone-number based only).
 */
export function migrateLidMessages(): void {
  const db = getDb();
  try {
    const lidChats = db.prepare(`SELECT jid FROM chats WHERE jid LIKE '%@lid'`).all() as { jid: string }[];
    let merged = 0;
    for (const chat of lidChats) {
      const resolved = resolveJidPhoneOnly(chat.jid);
      if (resolved && resolved !== chat.jid) {
        db.prepare(`INSERT OR IGNORE INTO chats (jid, name, last_message_time) SELECT ?, name, last_message_time FROM chats WHERE jid = ?`).run(resolved, chat.jid);
        db.prepare(`UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?`).run(resolved, chat.jid);
        db.prepare(`UPDATE OR IGNORE messages SET sender = ? WHERE sender = ?`).run(resolved, chat.jid);
        db.prepare(`DELETE FROM messages WHERE chat_jid = ? AND id IN (SELECT id FROM messages WHERE chat_jid = ?)`).run(chat.jid, resolved);
        db.prepare(`DELETE FROM chats WHERE jid = ?`).run(chat.jid);
        merged++;
      }
    }
    if (merged > 0) console.log(`[LID] Runtime migration merged ${merged} chats.`);
  } catch (err) {
    console.error("Error in runtime LID migration:", err);
  }
}

// Trailing-debounce wrapper: many contacts.update events in burst -> one scan.
let lidMigrationTimer: NodeJS.Timeout | null = null;
export function scheduleLidMigration(delayMs: number = 2000): void {
  if (lidMigrationTimer) clearTimeout(lidMigrationTimer);
  lidMigrationTimer = setTimeout(() => {
    lidMigrationTimer = null;
    migrateLidMessages();
  }, delayMs);
}

export function debugLidMapping(_logger: any): void {
  const db = getDb();
  try {
    const lidContacts = db.prepare(`SELECT jid, name, notify, phone_number FROM contacts WHERE jid LIKE '%@lid'`).all() as any[];
    const chats = db.prepare(`SELECT jid, name, last_message_time FROM chats WHERE jid LIKE '%@lid'`).all() as any[];

    console.log("\n=== DEBUG: @lid Mapping Status ===");
    console.log(`Total @lid contacts in DB: ${lidContacts.length}`);
    console.log(`Total @lid chats in DB: ${chats.length}`);
    
    for (const chat of chats) {
      const contact = lidContacts.find(c => c.jid === chat.jid);
      console.log(`- Chat: ${chat.name || 'Unknown'} (${chat.jid})`);
      console.log(`  -> Contact Match: ${contact ? 'YES' : 'NO'}`);
      if (contact) {
        console.log(`  -> Contact Name: ${contact.name || 'None'}`);
        console.log(`  -> Contact Notify: ${contact.notify || 'None'}`);
        console.log(`  -> Contact Phone: ${contact.phone_number || 'MISSING!'}`);
        
        let fuzzyResult = "NO ❌";
        let resolvedJid = null;
        const searchName = contact.name || contact.notify;
        if (!contact.phone_number && searchName && searchName.trim().length > 2) {
            const searchTerm = searchName.trim();
            const matches = db.prepare(`
              SELECT jid FROM contacts 
              WHERE jid LIKE '%@s.whatsapp.net' 
              AND (LOWER(name) = LOWER(?) OR LOWER(notify) = LOWER(?) OR LOWER(name) LIKE LOWER(?) OR LOWER(notify) LIKE LOWER(?))
            `).all(searchTerm, searchTerm, `${searchTerm} %`, `${searchTerm} %`) as { jid: string }[];
            if (matches.length === 1) {
                fuzzyResult = `YES (Fuzzy matched to ${matches[0].jid}) ✅`;
            } else if (matches.length > 1) {
                fuzzyResult = `NO (Ambiguous: ${matches.length} matches) ❌`;
            }
        }
        
        console.log(`  -> Auto-Resolve Possible: ${contact.phone_number ? 'YES (via Phone) ✅' : fuzzyResult}`);
      }
      console.log("----------------------------------");
    }
    console.log("====================================\n");
  } catch (err) {
    console.error("Error running debugLidMapping:", err);
  }
}

/**
 * Phone-number based resolution only. SAFE for write paths (storeMessage,
 * storeChat, migrations) because exact-match phone numbers cannot misroute.
 */
export function resolveJidPhoneOnly(jid: string | null | undefined): string | null {
  if (!jid) return null;
  if (!jid.endsWith("@lid")) return jid;

  const db = getDb();
  try {
    const row = db
      .prepare(`SELECT phone_number FROM contacts WHERE jid = ?`)
      .get(jid) as { phone_number: string | null } | undefined;
    if (row?.phone_number) {
      const cleanPhone = row.phone_number.replace(/[^0-9]/g, "");
      if (cleanPhone) {
        vlog(`[LID] RESOLVE (phone): ${jid} -> ${cleanPhone}@s.whatsapp.net`);
        return `${cleanPhone}@s.whatsapp.net`;
      }
    }
  } catch (err) {
    console.error("Error resolving JID (phone-only):", err);
  }
  return jid;
}

/**
 * Phone-first, then fuzzy-name resolution. ONLY for read/display paths
 * where a wrong match merely shows the wrong label (not misroutes a send).
 * Do NOT use this for storeMessage/storeChat.
 */
export function resolveJidSync(jid: string | null | undefined): string | null {
  if (!jid) return null;
  if (!jid.endsWith("@lid")) return jid;

  const phone = resolveJidPhoneOnly(jid);
  if (phone && phone !== jid) return phone;

  const db = getDb();
  try {
    const row = db
      .prepare(`SELECT name, notify FROM contacts WHERE jid = ?`)
      .get(jid) as { name: string | null; notify: string | null } | undefined;
    const searchName = row?.name || row?.notify;
    if (searchName && searchName.trim().length > 2) {
      const searchTerm = searchName.trim();
      const matches = db
        .prepare(`
          SELECT jid FROM contacts
          WHERE jid LIKE '%@s.whatsapp.net'
          AND (
            LOWER(name) = LOWER(?) OR
            LOWER(notify) = LOWER(?) OR
            LOWER(name) LIKE LOWER(?) OR
            LOWER(notify) LIKE LOWER(?)
          )
        `)
        .all(searchTerm, searchTerm, `${searchTerm} %`, `${searchTerm} %`) as { jid: string }[];
      if (matches.length === 1) {
        vlog(`[LID] RESOLVE (fuzzy): ${jid} -> ${matches[0].jid} (matched: "${searchTerm}")`);
        return matches[0].jid;
      }
    }
  } catch (err) {
    console.error("Error resolving JID (fuzzy):", err);
  }
  return jid;
}

export function storeChat(chat: Partial<Chat> & { jid: string }): void {
  const db = getDb();
  // Write path uses phone-only resolver to avoid fuzzy-name misroutes.
  const resolvedJid = resolveJidPhoneOnly(chat.jid)!;
  try {
    const stmt = db.prepare(`
            INSERT INTO chats (jid, name, last_message_time)
            VALUES (@jid, @name, @last_message_time)
            ON CONFLICT(jid) DO UPDATE SET
                name = COALESCE(excluded.name, name),
                last_message_time = COALESCE(excluded.last_message_time, last_message_time)
        `);
    stmt.run({
      jid: resolvedJid,
      name: chat.name ?? null,
      last_message_time:
        chat.last_message_time instanceof Date
          ? chat.last_message_time.toISOString()
          : chat.last_message_time === null
            ? null
            : String(chat.last_message_time),
    });
  } catch (error) {
    console.error("Error storing chat:", error);
  }
}

export function storeMessage(message: Message): void {
  const db = getDb();
  const resolvedChatJid = resolveJidPhoneOnly(message.chat_jid)!;
  const resolvedSender = resolveJidPhoneOnly(message.sender);

  try {
    // Only insert the chat if it doesn't exist, we don't need to update last_message_time twice
    db.prepare(`INSERT OR IGNORE INTO chats (jid, last_message_time) VALUES (?, ?)`).run(resolvedChatJid, message.timestamp.toISOString());

    const stmt = db.prepare(`
            INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, sender_push_name)
            VALUES (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me, @sender_push_name)
            ON CONFLICT(id, chat_jid) DO UPDATE SET
                sender = excluded.sender,
                content = excluded.content,
                timestamp = excluded.timestamp,
                is_from_me = excluded.is_from_me,
                sender_push_name = COALESCE(excluded.sender_push_name, sender_push_name)
        `);

    stmt.run({
      id: message.id,
      chat_jid: resolvedChatJid,
      sender: resolvedSender ?? null,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      is_from_me: message.is_from_me ? 1 : 0,
      sender_push_name: message.sender_push_name ?? null,
    });

    const updateChatTimeStmt = db.prepare(`
            UPDATE chats
            SET last_message_time = MAX(COALESCE(last_message_time, '1970-01-01T00:00:00.000Z'), @timestamp)
            WHERE jid = @jid
        `);
    updateChatTimeStmt.run({
      timestamp: message.timestamp.toISOString(),
      jid: resolvedChatJid,
    });
  } catch (error) {
    console.error("Error storing message:", error);
  }
}

export function storeMessagesBatch(messages: Message[]): void {
  if (messages.length === 0) return;
  const db = getDb();
  // Per-batch resolver cache: same JID resolves to same target N times -> 1 query.
  const resolveCache = new Map<string, string | null>();
  const resolve = (jid: string | null | undefined): string | null => {
    if (!jid) return null;
    if (resolveCache.has(jid)) return resolveCache.get(jid)!;
    const r = resolveJidPhoneOnly(jid);
    resolveCache.set(jid, r);
    return r;
  };
  try {
    db.exec("BEGIN TRANSACTION");
    const insertChatStmt = db.prepare(`INSERT OR IGNORE INTO chats (jid, last_message_time) VALUES (?, ?)`);
    const insertMsgStmt = db.prepare(`
            INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, sender_push_name)
            VALUES (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me, @sender_push_name)
            ON CONFLICT(id, chat_jid) DO UPDATE SET
                sender = excluded.sender,
                content = excluded.content,
                timestamp = excluded.timestamp,
                is_from_me = excluded.is_from_me,
                sender_push_name = COALESCE(excluded.sender_push_name, sender_push_name)
        `);
    const updateChatTimeStmt = db.prepare(`
            UPDATE chats
            SET last_message_time = MAX(COALESCE(last_message_time, '1970-01-01T00:00:00.000Z'), @timestamp)
            WHERE jid = @jid
        `);

    for (const msg of messages) {
      const resolvedChatJid = resolve(msg.chat_jid)!;
      const resolvedSender = resolve(msg.sender);
      const isoTime = msg.timestamp.toISOString();
      
      insertChatStmt.run(resolvedChatJid, isoTime);
      insertMsgStmt.run({
        id: msg.id,
        chat_jid: resolvedChatJid,
        sender: resolvedSender,
        content: msg.content,
        timestamp: isoTime,
        is_from_me: msg.is_from_me ? 1 : 0,
        sender_push_name: msg.sender_push_name ?? null,
      });
      updateChatTimeStmt.run({
        timestamp: isoTime,
        jid: resolvedChatJid,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("Error storing messages batch:", error);
  }
}

function parseDateSafe(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) {
    return null;
  }
}

function rowToMessage(row: any): Message {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    sender_name: row.sender_name ?? null,
    sender_push_name: row.sender_push_name ?? null,
    content: row.content,
    timestamp: parseDateSafe(row.timestamp)!,
    is_from_me: Boolean(row.is_from_me),
    chat_name: row.chat_name,
  };
}

function rowToChat(row: any): Chat {
  return {
    jid: row.jid,
    name: row.name,
    last_message_time: parseDateSafe(row.last_message_time),
    last_message: row.last_message,
    last_sender: row.last_sender,
    last_sender_name: row.last_sender_name ?? null,
    last_sender_push_name: row.last_sender_push_name ?? null,
    last_is_from_me:
      row.last_is_from_me !== null ? Boolean(row.last_is_from_me) : null,
  };
}

export function getMessages(
  chatJid: string,
  limit: number = 20,
  page: number = 0,
  sinceIso?: string | null,
  untilIso?: string | null,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    let sql = `
            SELECT m.*,
              COALESCE(c.name, cr_chat.display_name) AS chat_name,
              cr_sender.display_name AS sender_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts_resolved cr_chat ON c.jid = cr_chat.jid
            LEFT JOIN contacts_resolved cr_sender ON m.sender = cr_sender.jid
            WHERE m.chat_jid = ?
        `;
    const params: (string | number)[] = [chatJid];
    if (sinceIso) {
      sql += ` AND m.timestamp >= ?`;
      params.push(sinceIso);
    }
    if (untilIso) {
      sql += ` AND m.timestamp <= ?`;
      params.push(untilIso);
    }
    sql += ` ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error getting messages:", error);
    return [];
  }
}

/**
 * Cross-chat time-window query. Returns the most recent N messages across ALL
 * chats (or filtered to a chat) within the [since, until] window. Useful for
 * agent queries like "show me the last 8 hours of WhatsApp activity".
 */
export function getRecentMessages(
  sinceIso: string,
  untilIso?: string | null,
  chatJid?: string | null,
  limit: number = 50,
  page: number = 0,
  includeStatus: boolean = false,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    let sql = `
            SELECT m.*,
              COALESCE(c.name, cr_chat.display_name) AS chat_name,
              cr_sender.display_name AS sender_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts_resolved cr_chat ON c.jid = cr_chat.jid
            LEFT JOIN contacts_resolved cr_sender ON m.sender = cr_sender.jid
            WHERE m.timestamp >= ?
        `;
    const params: (string | number)[] = [sinceIso];
    if (untilIso) {
      sql += ` AND m.timestamp <= ?`;
      params.push(untilIso);
    }
    if (chatJid) {
      sql += ` AND m.chat_jid = ?`;
      params.push(chatJid);
    }
    // Exclude WhatsApp Status broadcasts unless the caller opted in or is
    // explicitly filtering to that JID.
    if (!includeStatus && chatJid !== STATUS_BROADCAST_JID) {
      sql += ` AND m.chat_jid != ?`;
      params.push(STATUS_BROADCAST_JID);
    }
    sql += ` ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error getting recent messages:", error);
    return [];
  }
}

export function getChats(
  limit: number = 20,
  page: number = 0,
  sortBy: "last_active" | "name" = "last_active",
  query?: string | null,
  includeLastMessage: boolean = true,
  includeStatus: boolean = false,
): Chat[] {
  const db = getDb();
  try {
    const offset = page * limit;
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, cr.display_name) AS name,
                c.last_message_time
                ${
                  includeLastMessage
                    ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT cr_s.display_name FROM messages m LEFT JOIN contacts_resolved cr_s ON m.sender = cr_s.jid WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender_name,
                (SELECT m.sender_push_name FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender_push_name,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
                    : ""
                }
            FROM chats c
            LEFT JOIN contacts_resolved cr ON c.jid = cr.jid
        `;

    const params: (string | number)[] = [];
    const whereClauses: string[] = [];

    if (query) {
      whereClauses.push(
        `(LOWER(COALESCE(c.name, cr.display_name)) LIKE LOWER(?) OR c.jid LIKE ?)`,
      );
      params.push(`%${query}%`, `%${query}%`);
    }

    // The Status "chat" is internal-only; hide unless explicitly requested.
    if (!includeStatus) {
      whereClauses.push(`c.jid != ?`);
      params.push(STATUS_BROADCAST_JID);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    const orderByClause =
      sortBy === "last_active"
        ? "c.last_message_time DESC NULLS LAST"
        : "COALESCE(c.name, cr.display_name) ASC";
    sql += ` ORDER BY ${orderByClause}, c.jid ASC`;

    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToChat);
  } catch (error) {
    console.error("Error getting chats:", error);
    return [];
  }
}

export function getChat(
  jid: string,
  includeLastMessage: boolean = true,
): Chat | null {
  const db = getDb();
  try {
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, cr.display_name) AS name,
                c.last_message_time
                ${
                  includeLastMessage
                    ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT cr_s.display_name FROM messages m LEFT JOIN contacts_resolved cr_s ON m.sender = cr_s.jid WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender_name,
                (SELECT m.sender_push_name FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender_push_name,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
                    : ""
                }
            FROM chats c
            LEFT JOIN contacts_resolved cr ON c.jid = cr.jid
            WHERE c.jid = ?
        `;

    const stmt = db.prepare(sql);
    const row = stmt.get(jid) as any | undefined;
    return row ? rowToChat(row) : null;
  } catch (error) {
    console.error("Error getting chat:", error);
    return null;
  }
}

export function getMessagesAround(
  messageId: string,
  before: number = 5,
  after: number = 5,
): { before: Message[]; target: Message | null; after: Message[] } {
  const db = getDb();
  const result: {
    before: Message[];
    target: Message | null;
    after: Message[];
  } = { before: [], target: null, after: [] };

  const MSG_WITH_SENDER = `
    SELECT m.*,
      COALESCE(c.name, cr_chat.display_name) AS chat_name,
      cr_sender.display_name AS sender_name
    FROM messages m
    JOIN chats c ON m.chat_jid = c.jid
    LEFT JOIN contacts_resolved cr_chat ON c.jid = cr_chat.jid
    LEFT JOIN contacts_resolved cr_sender ON m.sender = cr_sender.jid
  `;

  try {
    const targetStmt = db.prepare(`${MSG_WITH_SENDER} WHERE m.id = ?`);
    const targetRow = targetStmt.get(messageId) as any | undefined;

    if (!targetRow) {
      return result;
    }
    result.target = rowToMessage(targetRow);
    const targetTimestamp = result.target.timestamp.toISOString();
    const chatJid = result.target.chat_jid;

    const beforeStmt = db.prepare(`
      ${MSG_WITH_SENDER}
      WHERE m.chat_jid = ? AND m.timestamp < ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `);
    result.before = (beforeStmt.all(chatJid, targetTimestamp, before) as any[]).map(rowToMessage).reverse();

    const afterStmt = db.prepare(`
      ${MSG_WITH_SENDER}
      WHERE m.chat_jid = ? AND m.timestamp > ?
      ORDER BY m.timestamp ASC
      LIMIT ?
    `);
    result.after = (afterStmt.all(chatJid, targetTimestamp, after) as any[]).map(rowToMessage);

    return result;
  } catch (error) {
    console.error("Error getting messages around:", error);
    return result;
  }
}

export function searchDbForContacts(
  query: string,
  limit: number = 20
): { jid: string; name: string | null }[] {
  const db = getDb();
  try {
    const pattern = `%${query}%`;

    const stmt = db.prepare(`
      SELECT cr.jid AS jid, cr.display_name AS display_name
      FROM contacts_resolved cr
      WHERE
        LOWER(COALESCE(cr.display_name, cr.jid)) LIKE LOWER(?)
      LIMIT ?
    `);

    const rows = stmt.all(pattern, limit) as {
      jid: string;
      display_name: string | null;
    }[];

    return rows.map((r) => ({
      jid: r.jid,
      name: r.display_name,
    }));
  } catch (error) {
    console.error("Error searching contacts:", error);
    return [];
  }
}

/** Escape FTS5 special characters and wrap as a phrase for safe MATCH. */
function escapeFtsQuery(q: string): string {
  // Replace internal double-quote with two double-quotes, wrap in quotes -> phrase match.
  return `"${q.replace(/"/g, '""')}"`;
}

function ftsAvailable(db: DatabaseSync): boolean {
  try {
    db.prepare(`SELECT 1 FROM messages_fts LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

export function searchMessages(
  searchQuery: string,
  chatJid?: string | null,
  limit: number = 10,
  page: number = 0,
  includeStatus: boolean = false,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const useFts = ftsAvailable(db) && searchQuery.trim().length > 0;

    let sql: string;
    const params: (string | number | null)[] = [];

    if (useFts) {
      sql = `
            SELECT m.*,
              COALESCE(c.name, cr_chat.display_name) AS chat_name,
              cr_sender.display_name AS sender_name
            FROM messages_fts f
            JOIN messages m ON m.rowid = f.rowid
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts_resolved cr_chat ON c.jid = cr_chat.jid
            LEFT JOIN contacts_resolved cr_sender ON m.sender = cr_sender.jid
            WHERE messages_fts MATCH ?
        `;
      params.push(escapeFtsQuery(searchQuery));
    } else {
      sql = `
            SELECT m.*,
              COALESCE(c.name, cr_chat.display_name) AS chat_name,
              cr_sender.display_name AS sender_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts_resolved cr_chat ON c.jid = cr_chat.jid
            LEFT JOIN contacts_resolved cr_sender ON m.sender = cr_sender.jid
            WHERE LOWER(m.content) LIKE LOWER(?)
        `;
      params.push(`%${searchQuery}%`);
    }

    if (chatJid) {
      sql += ` AND m.chat_jid = ?`;
      params.push(chatJid);
    }
    if (!includeStatus && chatJid !== STATUS_BROADCAST_JID) {
      sql += ` AND m.chat_jid != ?`;
      params.push(STATUS_BROADCAST_JID);
    }

    sql += ` ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error searching messages:", error);
    return [];
  }
}

/**
 * Fetch a single message by its ID. Returns null if not found.
 * Used by edit_message to validate the target before sending the edit.
 */
export function getMessageById(messageId: string): Message | null {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT m.*,
        COALESCE(c.name, cr_chat.display_name) AS chat_name,
        cr_sender.display_name AS sender_name
      FROM messages m
      JOIN chats c ON m.chat_jid = c.jid
      LEFT JOIN contacts_resolved cr_chat ON c.jid = cr_chat.jid
      LEFT JOIN contacts_resolved cr_sender ON m.sender = cr_sender.jid
      WHERE m.id = ?
      LIMIT 1
    `).get(messageId) as any | undefined;
    return row ? rowToMessage(row) : null;
  } catch (error) {
    console.error("Error getting message by ID:", error);
    return null;
  }
}

/**
 * Update the content of an existing message in the local DB.
 * Called after a successful WhatsApp edit so local state stays in sync.
 */
export function updateMessageContent(messageId: string, chatJid: string, newContent: string): boolean {
  const db = getDb();
  try {
    const result = db.prepare(
      `UPDATE messages SET content = ? WHERE id = ? AND chat_jid = ?`
    ).run(newContent, messageId, chatJid);
    return (result.changes ?? 0) > 0;
  } catch (error) {
    console.error("Error updating message content:", error);
    return false;
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
      dbInstance = null;
      console.log("Database connection closed.");
    } catch (error) {
      console.error("Error closing database:", error);
    }
  }
}

/** Extract phone digits from a `digits@s.whatsapp.net` JID, else null. */
function phoneFromJid(jid: string): string | null {
  const m = jid.match(/^(\d+)@s\.whatsapp\.net$/);
  return m ? m[1] : null;
}

/**
 * Persist the deterministic mapping that Baileys exposes in every group
 * message envelope: `key.participant` is an @lid identifier and
 * `key.participantPn` is the same person's phone-number-form
 * @s.whatsapp.net JID. Capturing this lets contacts_resolved link the @lid
 * row to the user's saved address-book entry without notify-string heuristics.
 *
 * Idempotent: subsequent calls for the same lid_jid are ignored.
 */
export function storeLidAlias(lidJid: string, sJid: string): void {
  if (!lidJid.endsWith("@lid") || !sJid.endsWith("@s.whatsapp.net")) {
    return;
  }
  const db = getDb();
  try {
    db.prepare(
      `INSERT OR IGNORE INTO lid_aliases (lid_jid, s_jid, first_seen) VALUES (?, ?, ?)`,
    ).run(lidJid, sJid, new Date().toISOString());
    // Linking changed; the fuzzy cache is keyed on saved names, but the
    // contacts_resolved view will now return different display strings for
    // affected @lid contacts. Drop the cache so the resolver re-reads.
    invalidateContactResolverCache();
  } catch (error) {
    console.error("Error storing lid alias:", error);
  }
}

export function storeContact(contact: {
  jid: string;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
}): void {
  const db = getDb();
  try {
    // If Baileys didn't supply a phone number but the JID is digits@s.whatsapp.net,
    // we already have it embedded in the JID. Backfill so the @lid resolver works.
    const phone =
      contact.phoneNumber && contact.phoneNumber.length > 0
        ? contact.phoneNumber
        : phoneFromJid(contact.jid);

    const stmt = db.prepare(`
      INSERT INTO contacts (jid, name, notify, phone_number)
      VALUES (@jid, @name, @notify, @phone_number)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        notify = COALESCE(excluded.notify, notify),
        phone_number = COALESCE(excluded.phone_number, phone_number)
    `);

    stmt.run({
      jid: contact.jid,
      name: contact.name ?? null,
      notify: contact.notify ?? null,
      phone_number: phone,
    });

    // The fuzzy resolver caches `name`-bearing @s.whatsapp.net contacts. Any
    // write may have added or changed one, so drop the cache.
    if (contact.name) {
      invalidateContactResolverCache();
    }
  } catch (error) {
    console.error("Error storing contact:", error);
  }
}
