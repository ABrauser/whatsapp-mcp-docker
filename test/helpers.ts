/**
 * Test helpers — provide an in-memory SQLite database with the production
 * schema and migrations applied, so each test gets an isolated DB without
 * file I/O.
 */
import { DatabaseSync } from "node:sqlite";
import { runMigrations, APP_MIGRATIONS } from "../src/migrations.ts";

/** Build an in-memory database with the same schema the app expects. */
export function newTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");

  db.exec("PRAGMA journal_mode = MEMORY");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      sender_push_name TEXT,
      PRIMARY KEY (id, chat_jid)
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

  // Apply only versioned migrations that don't conflict with the manual schema
  // above. Migration #3 (sender_push_name) is a no-op because the column is
  // already present, but we still record it as applied so the runner stays
  // consistent.
  runMigrations(db, APP_MIGRATIONS);

  // Mirror the production resolution view so DRY queries can be tested.
  db.exec(`DROP VIEW IF EXISTS contacts_resolved`);
  db.exec(`
    CREATE VIEW contacts_resolved AS
    SELECT
      ct.jid,
      ct.name,
      ct.notify,
      ct.phone_number,
      COALESCE(
        ct.name,
        CASE WHEN ct.jid LIKE '%@lid' AND ct.notify IS NOT NULL THEN
          (SELECT ct2.name FROM contacts ct2
           WHERE ct2.jid LIKE '%@s.whatsapp.net'
             AND ct2.notify = ct.notify
             AND ct2.name IS NOT NULL
           LIMIT 1)
        END,
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

  return db;
}

/** Insert a contact with optional fields. */
export function insertContact(
  db: DatabaseSync,
  c: { jid: string; name?: string | null; notify?: string | null; phone?: string | null },
): void {
  db.prepare(
    `INSERT INTO contacts (jid, name, notify, phone_number) VALUES (?, ?, ?, ?)`,
  ).run(c.jid, c.name ?? null, c.notify ?? null, c.phone ?? null);
}
