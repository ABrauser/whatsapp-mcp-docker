import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? "\\\\nexus\\docker\\whatsapp-mcp\\data\\whatsapp.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log(`Reading: ${dbPath}\n`);

// 1) Last 12h of group messages
console.log("=== Last 12h, group chats, sender JIDs ===");
const groupMsgs = db
  .prepare(`
    SELECT
      datetime(timestamp) AS ts,
      chat_jid,
      sender,
      is_from_me,
      substr(content, 1, 60) AS preview
    FROM messages
    WHERE timestamp > datetime('now', '-12 hours')
      AND chat_jid LIKE '%g.us'
    ORDER BY timestamp DESC
    LIMIT 30
  `)
  .all();
for (const r of groupMsgs) {
  console.log(
    `  ${r.ts}  sender=${r.sender ?? "<NULL>"}  fromMe=${r.is_from_me}  | ${r.preview ?? ""}`,
  );
}

// 2) Tammy / TamTam contacts
console.log("\n=== TamTam / Tammy contact rows ===");
const tammyRows = db
  .prepare(`
    SELECT jid, name, notify, phone_number
    FROM contacts
    WHERE name LIKE '%Tam%' OR notify LIKE '%Tam%'
  `)
  .all();
for (const r of tammyRows) {
  console.log(
    `  ${r.jid.padEnd(40)} name=${(r.name ?? "").padEnd(20)} notify=${(r.notify ?? "").padEnd(15)} phone=${r.phone_number ?? ""}`,
  );
}

// 3) Mary contacts
console.log("\n=== Mary contact rows ===");
const maryRows = db
  .prepare(`
    SELECT jid, name, notify, phone_number
    FROM contacts
    WHERE name LIKE '%Mary%' OR notify LIKE '%Mary%' OR notify LIKE '%Bauer%' OR name LIKE '%Bauer%'
  `)
  .all();
for (const r of maryRows) {
  console.log(
    `  ${r.jid.padEnd(40)} name=${(r.name ?? "").padEnd(25)} notify=${(r.notify ?? "").padEnd(20)} phone=${r.phone_number ?? ""}`,
  );
}

// 4) DB scale check
console.log("\n=== DB scale ===");
const stats = db
  .prepare(`
    SELECT
      (SELECT COUNT(*) FROM chats) AS chats,
      (SELECT COUNT(*) FROM messages) AS msgs,
      (SELECT COUNT(*) FROM contacts) AS contacts,
      (SELECT COUNT(*) FROM contacts WHERE phone_number IS NOT NULL AND phone_number != '') AS with_phone,
      (SELECT COUNT(*) FROM contacts WHERE notify IS NOT NULL AND notify != '') AS with_notify,
      (SELECT COUNT(DISTINCT chat_jid) FROM messages) AS distinct_chat_jids,
      (SELECT datetime(MAX(timestamp)) FROM messages) AS newest_msg
  `)
  .get();
console.log(JSON.stringify(stats, null, 2));

db.close();
