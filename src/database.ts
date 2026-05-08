import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = process.env.WHATSAPP_MCP_DATA_DIR
  ? path.resolve(process.env.WHATSAPP_MCP_DATA_DIR)
  : path.join(import.meta.dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "whatsapp.db");

export interface Chat {
  jid: string;
  name?: string | null;
  last_message_time?: Date | null;
  last_message?: string | null;
  last_sender?: string | null;
  last_is_from_me?: boolean | null;
}

export type Message = {
  id: string;
  chat_jid: string;
  sender?: string | null;
  content: string;
  timestamp: Date;
  is_from_me: boolean;
  chat_name?: string | null;
};

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!dbInstance) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    dbInstance = new DatabaseSync(DB_PATH);
  }
  return dbInstance;
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
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats (last_message_time);`,
  );

  // --- Migration: Merge existing @lid messages into @s.whatsapp.net ---
  try {
    db.exec(`
      UPDATE OR IGNORE messages 
      SET chat_jid = (SELECT phone_number || '@s.whatsapp.net' FROM contacts WHERE contacts.jid = messages.chat_jid AND phone_number IS NOT NULL)
      WHERE chat_jid LIKE '%@lid' AND EXISTS (SELECT 1 FROM contacts WHERE contacts.jid = messages.chat_jid AND phone_number IS NOT NULL);
    `);
    
    // Update sender JIDs as well
    db.exec(`
      UPDATE OR IGNORE messages 
      SET sender = (SELECT phone_number || '@s.whatsapp.net' FROM contacts WHERE contacts.jid = messages.sender AND phone_number IS NOT NULL)
      WHERE sender LIKE '%@lid' AND EXISTS (SELECT 1 FROM contacts WHERE contacts.jid = messages.sender AND phone_number IS NOT NULL);
    `);

    // Clean up empty @lid chats that have no messages left
    db.exec(`
      DELETE FROM chats 
      WHERE jid LIKE '%@lid' AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat_jid = chats.jid);
    `);
  } catch (err) {
    console.error("Migration error for @lid merge:", err);
  }

  return db;
}

export function debugLidMapping(logger: any): void {
  const db = getDb();
  try {
    const lidContacts = db.prepare(`SELECT jid, name, notify, phone_number FROM contacts WHERE jid LIKE '%@lid'`).all() as any[];
    const chats = db.prepare(`SELECT jid, name, last_message_time FROM chats WHERE jid LIKE '%@lid'`).all() as any[];
    
    logger.info("=== DEBUG: @lid Mapping Status ===");
    logger.info(`Total @lid contacts in DB: ${lidContacts.length}`);
    logger.info(`Total @lid chats in DB: ${chats.length}`);
    
    for (const chat of chats) {
      const contact = lidContacts.find(c => c.jid === chat.jid);
      logger.info({
        chatJid: chat.jid,
        chatName: chat.name,
        contactName: contact?.name,
        contactNotify: contact?.notify,
        contactPhone: contact?.phone_number,
        canAutoResolve: !!contact?.phone_number
      }, "Unresolved @lid Chat Analysis:");
    }
    logger.info("====================================");
  } catch (err) {
    logger.error("Error running debugLidMapping:", err);
  }
}

export function resolveJidSync(jid: string | null | undefined): string | null {
  if (!jid) return null;
  if (!jid.endsWith("@lid")) return jid;

  const db = getDb();
  try {
    const stmt = db.prepare(`SELECT phone_number FROM contacts WHERE jid = ?`);
    const row = stmt.get(jid) as { phone_number: string | null } | undefined;
    if (row && row.phone_number) {
      // Clean up phone number just in case
      const cleanPhone = row.phone_number.replace(/[^0-9]/g, "");
      if (cleanPhone) {
        return `${cleanPhone}@s.whatsapp.net`;
      }
    }
  } catch (err) {
    console.error("Error resolving JID:", err);
  }
  return jid;
}

export function storeChat(chat: Partial<Chat> & { jid: string }): void {
  const db = getDb();
  const resolvedJid = resolveJidSync(chat.jid)!;
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
  const resolvedChatJid = resolveJidSync(message.chat_jid)!;
  const resolvedSender = resolveJidSync(message.sender);
  
  try {
    // Only insert the chat if it doesn't exist, we don't need to update last_message_time twice
    db.prepare(`INSERT OR IGNORE INTO chats (jid, last_message_time) VALUES (?, ?)`).run(resolvedChatJid, message.timestamp.toISOString());

    const stmt = db.prepare(`
            INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me)
            VALUES (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me)
        `);

    stmt.run({
      id: message.id,
      chat_jid: resolvedChatJid,
      sender: resolvedSender ?? null,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      is_from_me: message.is_from_me ? 1 : 0,
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
  try {
    db.exec("BEGIN TRANSACTION");
    const insertChatStmt = db.prepare(`INSERT OR IGNORE INTO chats (jid, last_message_time) VALUES (?, ?)`);
    const insertMsgStmt = db.prepare(`
            INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me)
            VALUES (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me)
        `);
    const updateChatTimeStmt = db.prepare(`
            UPDATE chats
            SET last_message_time = MAX(COALESCE(last_message_time, '1970-01-01T00:00:00.000Z'), @timestamp)
            WHERE jid = @jid
        `);

    for (const msg of messages) {
      const isoTime = msg.timestamp.toISOString();
      insertChatStmt.run(msg.chat_jid, isoTime);
      insertMsgStmt.run({
        id: msg.id,
        chat_jid: msg.chat_jid,
        sender: msg.sender ?? null,
        content: msg.content,
        timestamp: isoTime,
        is_from_me: msg.is_from_me ? 1 : 0,
      });
      updateChatTimeStmt.run({
        timestamp: isoTime,
        jid: msg.chat_jid,
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
    last_is_from_me:
      row.last_is_from_me !== null ? Boolean(row.last_is_from_me) : null,
  };
}

export function getMessages(
  chatJid: string,
  limit: number = 20,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const stmt = db.prepare(`
            SELECT m.*, c.name as chat_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            WHERE m.chat_jid = ?
            ORDER BY m.timestamp DESC
            LIMIT ?
            OFFSET ?
        `);
    const rows = stmt.all(chatJid, limit, offset) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error getting messages:", error);
    return [];
  }
}

export function getChats(
  limit: number = 20,
  page: number = 0,
  sortBy: "last_active" | "name" = "last_active",
  query?: string | null,
  includeLastMessage: boolean = true,
): Chat[] {
  const db = getDb();
  try {
    const offset = page * limit;
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
                c.last_message_time
                ${
                  includeLastMessage
                    ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
                    : ""
                }
            FROM chats c
            LEFT JOIN contacts ct ON c.jid = ct.jid
        `;

    const params: (string | number)[] = [];

    if (query) {
      sql += ` WHERE (LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number)) LIKE LOWER(?) OR c.jid LIKE ?)`;
      params.push(`%${query}%`, `%${query}%`);
    }

    const orderByClause =
      sortBy === "last_active"
        ? "c.last_message_time DESC NULLS LAST"
        : "COALESCE(c.name, ct.name, ct.notify, ct.phone_number) ASC";
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
                COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
                c.last_message_time
                ${
                  includeLastMessage
                    ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
                    : ""
                }
            FROM chats c
            LEFT JOIN contacts ct ON c.jid = ct.jid
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

  try {
    const targetStmt = db.prepare(`
             SELECT m.*, c.name as chat_name
             FROM messages m
             JOIN chats c ON m.chat_jid = c.jid
             WHERE m.id = ?
        `);
    const targetRow = targetStmt.get(messageId) as any | undefined;

    if (!targetRow) {
      return result;
    }
    result.target = rowToMessage(targetRow);
    const targetTimestamp = result.target.timestamp.toISOString();
    const chatJid = result.target.chat_jid;

    const beforeStmt = db.prepare(`
            SELECT m.*, c.name as chat_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            WHERE m.chat_jid = ? AND m.timestamp < ?
            ORDER BY m.timestamp DESC
            LIMIT ?
        `);
    const beforeRows = beforeStmt.all(
      chatJid,
      targetTimestamp,
      before,
    ) as any[];
    result.before = beforeRows.map(rowToMessage).reverse();

    const afterStmt = db.prepare(`
            SELECT m.*, c.name as chat_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            WHERE m.chat_jid = ? AND m.timestamp > ?
            ORDER BY m.timestamp ASC
            LIMIT ?
        `);
    const afterRows = afterStmt.all(chatJid, targetTimestamp, after) as any[];
    result.after = afterRows.map(rowToMessage);

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
      SELECT
        jid,
        COALESCE(name, notify, phone_number, jid) AS display_name
      FROM contacts
      WHERE
        LOWER(COALESCE(name, notify, phone_number, jid)) LIKE LOWER(?)
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

export function searchMessages(
  searchQuery: string,
  chatJid?: string | null,
  limit: number = 10,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const searchPattern = `%${searchQuery}%`;
    let sql = `
            SELECT m.*, COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as chat_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts ct ON c.jid = ct.jid
            WHERE LOWER(m.content) LIKE LOWER(?)
        `;
    const params: (string | number | null)[] = [searchPattern];

    if (chatJid) {
      sql += ` AND m.chat_jid = ?`;
      params.push(chatJid);
    }

    sql += ` ORDER BY m.timestamp DESC`;
    sql += ` LIMIT ?`;
    params.push(limit);
    sql += ` OFFSET ?`;
    params.push(offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error searching messages:", error);
    return [];
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

export function storeContact(contact: {
  jid: string;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
}): void {
  const db = getDb();
  try {
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
      phone_number: contact.phoneNumber ?? null,
    });
  } catch (error) {
    console.error("Error storing contact:", error);
  }
}
