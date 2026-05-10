/**
 * Versioned database migration framework.
 *
 * Schema-level objects (CREATE TABLE/INDEX/VIEW IF NOT EXISTS) are still set
 * up unconditionally on every start in initializeDatabase() because those are
 * idempotent no-ops. This file handles *data transforms* and *non-idempotent
 * schema changes* (ALTER TABLE ADD COLUMN) that should run exactly once.
 *
 * Each migration is identified by a monotonic integer version. Applied
 * versions are recorded in `schema_migrations`. Each migration runs in its
 * own transaction; on error the transaction rolls back and the migration
 * remains unapplied so the next start can retry.
 */
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  description: string;
  up(db: DatabaseSync): void;
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function appliedVersions(db: DatabaseSync): Set<number> {
  const rows = db.prepare(`SELECT version FROM schema_migrations`).all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

/** Helper: detect if a column exists on a table. */
export function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * Run all pending migrations in order. Each migration runs in its own
 * transaction; if it throws, the tx rolls back and the function rethrows so
 * startup fails loudly (a half-applied migration is much worse than a refusal
 * to start).
 */
export function runMigrations(db: DatabaseSync, migrations: Migration[]): void {
  ensureMigrationsTable(db);
  const done = appliedVersions(db);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const m of sorted) {
    if (done.has(m.version)) continue;

    try {
      db.exec("BEGIN");
      m.up(db);
      db.prepare(
        `INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
      ).run(m.version, m.description, new Date().toISOString());
      db.exec("COMMIT");
      console.log(`[Migrate] Applied #${m.version}: ${m.description}`);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore — already rolled back or no tx active
      }
      console.error(`[Migrate] FAILED #${m.version}: ${m.description}`, err);
      throw err;
    }
  }
}

/** Built-in migration set for this app. Append new entries; never edit history. */
export const APP_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "backfill phone_number on @s.whatsapp.net contacts from JID",
    up(db) {
      db.prepare(`
        UPDATE contacts
        SET phone_number = SUBSTR(jid, 1, INSTR(jid, '@') - 1)
        WHERE jid LIKE '%@s.whatsapp.net'
          AND (phone_number IS NULL OR phone_number = '')
          AND SUBSTR(jid, 1, INSTR(jid, '@') - 1) GLOB '[0-9]*'
      `).run();
    },
  },
  {
    version: 2,
    description: "merge @lid messages and chats into @s.whatsapp.net where phone_number is known",
    up(db) {
      // Move messages whose chat_jid is @lid but the contact has phone_number
      db.prepare(`
        UPDATE OR IGNORE messages
        SET chat_jid = (
          SELECT phone_number || '@s.whatsapp.net'
          FROM contacts
          WHERE contacts.jid = messages.chat_jid AND phone_number IS NOT NULL
        )
        WHERE chat_jid LIKE '%@lid'
          AND EXISTS (SELECT 1 FROM contacts WHERE contacts.jid = messages.chat_jid AND phone_number IS NOT NULL)
      `).run();

      // Same for sender JIDs
      db.prepare(`
        UPDATE OR IGNORE messages
        SET sender = (
          SELECT phone_number || '@s.whatsapp.net'
          FROM contacts
          WHERE contacts.jid = messages.sender AND phone_number IS NOT NULL
        )
        WHERE sender LIKE '%@lid'
          AND EXISTS (SELECT 1 FROM contacts WHERE contacts.jid = messages.sender AND phone_number IS NOT NULL)
      `).run();

      // Drop empty @lid chats now that messages have moved
      db.prepare(`
        DELETE FROM chats
        WHERE jid LIKE '%@lid'
          AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat_jid = chats.jid)
      `).run();
    },
  },
  {
    version: 3,
    description: "add messages.sender_push_name column for sender display fallback",
    up(db) {
      if (!columnExists(db, "messages", "sender_push_name")) {
        db.exec(`ALTER TABLE messages ADD COLUMN sender_push_name TEXT`);
      }
    },
  },
  {
    version: 4,
    description:
      "create lid_aliases table mapping @lid identifiers to @s.whatsapp.net JIDs",
    up(db) {
      // WhatsApp's group messages carry both `key.participant` (an opaque
      // @lid identifier) and `key.participantPn` (the phone-number-form
      // @s.whatsapp.net JID for the same person). Persisting this mapping
      // lets contacts_resolved deterministically link @lid contacts to the
      // user's saved address-book entries (which are keyed by @s JID),
      // without relying on fragile notify-string heuristics.
      db.exec(`
        CREATE TABLE IF NOT EXISTS lid_aliases (
          lid_jid TEXT PRIMARY KEY,
          s_jid   TEXT NOT NULL,
          first_seen TEXT NOT NULL
        );
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_lid_aliases_s_jid ON lid_aliases(s_jid);`,
      );
    },
  },
];
