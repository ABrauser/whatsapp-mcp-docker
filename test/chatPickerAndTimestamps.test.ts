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
  storeMessage,
  getChats,
  searchChatsAndContactsForPicker,
} from "../src/database.ts";
import { runMigrations, APP_MIGRATIONS } from "../src/migrations.ts";
import { expandAllowedChats } from "../src/tokens.ts";

let tmpDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wamcp-picker-ts-test-"));
  prevDataDir = process.env.WHATSAPP_MCP_DATA_DIR;
  process.env.WHATSAPP_MCP_DATA_DIR = tmpDir;
  initializeDatabase();
});

afterEach(() => {
  closeDatabase();
  if (prevDataDir === undefined) delete process.env.WHATSAPP_MCP_DATA_DIR;
  else process.env.WHATSAPP_MCP_DATA_DIR = prevDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("storeChat stores NULL for undefined/invalid last_message_time and preserves valid timestamps", () => {
  storeChat({ jid: "1203630001@g.us", name: "Group A" });

  const row1 = getDb()
    .prepare(`SELECT last_message_time FROM chats WHERE jid = ?`)
    .get("1203630001@g.us") as { last_message_time: string | null };
  assert.equal(row1.last_message_time, null);

  const realTime = new Date("2026-11-24T12:00:00.000Z");
  storeChat({ jid: "1203630001@g.us", name: "Group A", last_message_time: realTime });
  // Subsequent metadata-only update (last_message_time undefined) must NOT wipe valid timestamp
  storeChat({ jid: "1203630001@g.us", name: "Group A Renamed" });

  const row2 = getDb()
    .prepare(`SELECT name, last_message_time FROM chats WHERE jid = ?`)
    .get("1203630001@g.us") as { name: string; last_message_time: string | null };
  assert.equal(row2.name, "Group A Renamed");
  assert.equal(row2.last_message_time, "2026-11-24T12:00:00.000Z");
});

test("storeMessage overwrites pre-existing corrupted 'undefined' last_message_time", () => {
  getDb()
    .prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, 'undefined')`)
    .run("1203630002@g.us", "Corrupted Group");

  const ts = new Date("2026-11-24T15:30:00.000Z");
  storeMessage({
    id: "m1",
    chat_jid: "1203630002@g.us",
    sender: "491761234567@s.whatsapp.net",
    content: "hello",
    timestamp: ts,
    is_from_me: false,
  });

  const row = getDb()
    .prepare(`SELECT last_message_time FROM chats WHERE jid = ?`)
    .get("1203630002@g.us") as { last_message_time: string | null };
  assert.equal(row.last_message_time, "2026-11-24T15:30:00.000Z");
});

test("Migration #6 repairs corrupted 'undefined' timestamps from messages and sorts person chats cleanly", () => {
  const db = getDb();

  // Simulate pre-migration #6 DB state
  db.prepare(`DELETE FROM schema_migrations WHERE version = 6`).run();
  db.prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, 'undefined')`).run(
    "1203630003@g.us",
    "Empty Old Group",
  );
  db.prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, 'undefined')`).run(
    "1203630004@g.us",
    "Group With Msg",
  );
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(
    "gm-1",
    "1203630004@g.us",
    "491761111111@s.whatsapp.net",
    "group msg",
    "2026-11-20T10:00:00.000Z",
  );

  storeChat({
    jid: "491762222222@s.whatsapp.net",
    name: "Active Person",
    last_message_time: new Date("2026-11-24T16:00:00.000Z"),
  });

  runMigrations(db, APP_MIGRATIONS);

  const emptyGroup = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = ?`)
    .get("1203630003@g.us") as { last_message_time: string | null };
  assert.equal(emptyGroup.last_message_time, null);

  const msgGroup = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = ?`)
    .get("1203630004@g.us") as { last_message_time: string | null };
  assert.equal(msgGroup.last_message_time, "2026-11-20T10:00:00.000Z");

  // getChats must rank Active Person (2026-11-24) above Group With Msg (2026-11-20) and Empty Old Group (null)
  const ordered = getChats(10, 0, "last_active");
  assert.deepEqual(
    ordered.map((c) => c.jid),
    ["491762222222@s.whatsapp.net", "1203630004@g.us", "1203630003@g.us"],
  );
});

test("searchChatsAndContactsForPicker supports type filters, query search, and non-duplicated contact-only persons", () => {
  // 1. Group chat
  storeChat({
    jid: "1203630099@g.us",
    name: "Family Group",
    last_message_time: new Date("2026-11-24T10:00:00Z"),
  });
  // 2. Direct @s person chat
  storeContact({ jid: "491761110001@s.whatsapp.net", name: "Alice Direct" });
  storeChat({
    jid: "491761110001@s.whatsapp.net",
    name: "Alice Direct",
    last_message_time: new Date("2026-11-24T11:00:00Z"),
  });
  // 3. @lid person chat linked via lid_aliases to a @s contact (must NOT appear twice)
  storeContact({ jid: "491762220002@s.whatsapp.net", name: "Bob Linked" });
  storeContact({ jid: "888877776666@lid", name: null, notify: "Bob" });
  storeLidAlias("888877776666@lid", "491762220002@s.whatsapp.net");
  storeChat({
    jid: "888877776666@lid",
    name: null,
    last_message_time: new Date("2026-11-24T09:00:00Z"),
  });
  // 4. Saved contact with NO chat row yet (contact-only)
  storeContact({ jid: "491763330003@s.whatsapp.net", name: "Charlie ContactOnly" });

  const all = searchChatsAndContactsForPicker({ type: "all", limit: 50 });
  assert.deepEqual(
    all.map((e) => ({ jid: e.jid, isGroup: e.isGroup, isContactOnly: e.isContactOnly })),
    [
      { jid: "491761110001@s.whatsapp.net", isGroup: false, isContactOnly: false },
      { jid: "1203630099@g.us", isGroup: true, isContactOnly: false },
      { jid: "888877776666@lid", isGroup: false, isContactOnly: false },
      { jid: "491763330003@s.whatsapp.net", isGroup: false, isContactOnly: true },
    ],
  );

  const persons = searchChatsAndContactsForPicker({ type: "person", limit: 50 });
  assert.equal(persons.some((p) => p.isGroup), false);
  assert.deepEqual(
    persons.map((p) => p.jid),
    [
      "491761110001@s.whatsapp.net",
      "888877776666@lid",
      "491763330003@s.whatsapp.net",
    ],
  );

  const groups = searchChatsAndContactsForPicker({ type: "group", limit: 50 });
  assert.deepEqual(
    groups.map((g) => g.jid),
    ["1203630099@g.us"],
  );

  const charlie = searchChatsAndContactsForPicker({ query: "Charlie", type: "person" });
  assert.equal(charlie.length, 1);
  assert.equal(charlie[0].jid, "491763330003@s.whatsapp.net");
  assert.equal(charlie[0].isContactOnly, true);

  const bob = searchChatsAndContactsForPicker({ query: "Bob", type: "person" });
  assert.equal(bob.length, 1);
  assert.equal(bob[0].jid, "888877776666@lid");
  assert.equal(bob[0].name, "Bob Linked");
});

test("expandAllowedChats also expands bidirectionally via contacts.phone_number", () => {
  storeContact({
    jid: "777766665555@lid",
    notify: "Dana",
    phoneNumber: "4917699988877",
  });
  storeContact({
    jid: "4917699988877@s.whatsapp.net",
    name: "Dana Saved",
  });

  const fromLid = expandAllowedChats(["777766665555@lid"]);
  assert.ok(fromLid);
  assert.equal(fromLid.has("777766665555@lid"), true);
  assert.equal(fromLid.has("4917699988877@s.whatsapp.net"), true);

  const fromPhone = expandAllowedChats(["4917699988877@s.whatsapp.net"]);
  assert.ok(fromPhone);
  assert.equal(fromPhone.has("4917699988877@s.whatsapp.net"), true);
  assert.equal(fromPhone.has("777766665555@lid"), true);
});
