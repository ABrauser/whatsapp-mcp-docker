import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import {
  runMigrations,
  columnExists,
  APP_MIGRATIONS,
  type Migration,
} from "../src/migrations.ts";

test("runMigrations: applies pending and skips applied", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE x (n INTEGER)`);

  let runs = 0;
  const ms: Migration[] = [
    {
      version: 1,
      description: "insert 1",
      up(db) {
        db.prepare(`INSERT INTO x (n) VALUES (1)`).run();
        runs++;
      },
    },
  ];

  runMigrations(db, ms);
  runMigrations(db, ms);
  runMigrations(db, ms);

  assert.equal(runs, 1, "migration ran exactly once");
  const cnt = db.prepare(`SELECT COUNT(*) AS c FROM x`).get() as { c: number };
  assert.equal(cnt.c, 1);
});

test("runMigrations: respects monotonic version order", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE log (v INTEGER, ord INTEGER)`);
  let ord = 0;
  const ms: Migration[] = [
    { version: 3, description: "c", up(d) { d.prepare(`INSERT INTO log VALUES (3, ?)`).run(++ord); } },
    { version: 1, description: "a", up(d) { d.prepare(`INSERT INTO log VALUES (1, ?)`).run(++ord); } },
    { version: 2, description: "b", up(d) { d.prepare(`INSERT INTO log VALUES (2, ?)`).run(++ord); } },
  ];
  runMigrations(db, ms);

  const rows = db.prepare(`SELECT v, ord FROM log ORDER BY ord`).all() as { v: number; ord: number }[];
  assert.deepEqual(rows.map((r) => r.v), [1, 2, 3]);
});

test("runMigrations: failing migration rolls back and rethrows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE y (n INTEGER)`);
  const ms: Migration[] = [
    {
      version: 1,
      description: "boom",
      up() {
        throw new Error("boom");
      },
    },
  ];
  assert.throws(() => runMigrations(db, ms), /boom/);

  // Migration not recorded as applied → next run can retry.
  const applied = db
    .prepare(`SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 1`)
    .get() as { c: number };
  assert.equal(applied.c, 0);
});

test("columnExists: detects existing and missing columns", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE t (a TEXT, b INTEGER)`);
  assert.equal(columnExists(db, "t", "a"), true);
  assert.equal(columnExists(db, "t", "b"), true);
  assert.equal(columnExists(db, "t", "c"), false);
});

test("APP_MIGRATIONS: phone_number backfill from JID", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, content TEXT,
      timestamp TEXT, is_from_me INTEGER, sender_push_name TEXT,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT, phone_number TEXT);
  `);
  db.prepare(`INSERT INTO contacts (jid, name) VALUES (?, ?)`).run(
    "4917697335710@s.whatsapp.net",
    "Tammy",
  );
  db.prepare(`INSERT INTO contacts (jid, notify) VALUES (?, ?)`).run(
    "210444891463794@lid",
    "TamTam",
  );

  runMigrations(db, APP_MIGRATIONS);

  const tammy = db
    .prepare(`SELECT phone_number FROM contacts WHERE jid = ?`)
    .get("4917697335710@s.whatsapp.net") as { phone_number: string };
  assert.equal(tammy.phone_number, "4917697335710");

  const lid = db
    .prepare(`SELECT phone_number FROM contacts WHERE jid = ?`)
    .get("210444891463794@lid") as { phone_number: string | null };
  assert.equal(lid.phone_number, null, "@lid rows are not affected");
});

test("APP_MIGRATIONS: sender_push_name column added once", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, content TEXT,
      timestamp TEXT, is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, notify TEXT, phone_number TEXT);
  `);
  assert.equal(columnExists(db, "messages", "sender_push_name"), false);
  runMigrations(db, APP_MIGRATIONS);
  assert.equal(columnExists(db, "messages", "sender_push_name"), true);

  // Re-running is a no-op (column-exists guard prevents duplicate ALTER).
  runMigrations(db, APP_MIGRATIONS);
  assert.equal(columnExists(db, "messages", "sender_push_name"), true);
});
