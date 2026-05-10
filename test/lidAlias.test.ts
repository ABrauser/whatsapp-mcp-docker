/**
 * Integration tests for the @lid → @s.whatsapp.net deterministic mapping
 * via the new lid_aliases table and the contacts_resolved view.
 *
 * Mary case (saved name "Mary Bauer", push name "Mary Grace Bauer"):
 *   - WITHOUT alias: view falls through to notify → "Mary Grace Bauer"
 *   - WITH alias:    view links @lid to @s contact → "Mary Bauer"
 *
 * Tammy case (saved name "Tammy", push name "TamTam"):
 *   - WITHOUT alias: notify-fallback "TamTam"
 *   - WITH alias:    "Tammy"
 */
import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initializeDatabase,
  closeDatabase,
  storeContact,
  storeLidAlias,
  getDb,
} from "../src/database.ts";

let tmpDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wamcp-lid-test-"));
  prevDataDir = process.env.WHATSAPP_MCP_DATA_DIR;
  process.env.WHATSAPP_MCP_DATA_DIR = tmpDir;
  initializeDatabase();
});

afterEach(() => {
  closeDatabase();
  if (prevDataDir === undefined) delete process.env.WHATSAPP_MCP_DATA_DIR;
  else process.env.WHATSAPP_MCP_DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** Helper: read display_name from contacts_resolved for a given JID. */
function displayName(jid: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT display_name FROM contacts_resolved WHERE jid = ?`)
    .get(jid) as { display_name: string | null } | undefined;
  return row ? row.display_name : null;
}

test("Mary case: WITHOUT alias view falls back to notify", () => {
  storeContact({
    jid: "131683881869317@lid",
    name: null,
    notify: "Mary Grace Bauer",
  });
  storeContact({
    jid: "4917655263429@s.whatsapp.net",
    name: "Mary Bauer",
    notify: null, // empty notify — the user never received a 1:1 from her
  });

  // No alias yet → view's notify-fallback returns the push-name string.
  assert.equal(displayName("131683881869317@lid"), "Mary Grace Bauer");
});

test("Mary case: WITH alias view returns saved address-book name", () => {
  storeContact({
    jid: "131683881869317@lid",
    name: null,
    notify: "Mary Grace Bauer",
  });
  storeContact({
    jid: "4917655263429@s.whatsapp.net",
    name: "Mary Bauer",
    notify: null,
  });
  storeLidAlias("131683881869317@lid", "4917655263429@s.whatsapp.net");

  assert.equal(displayName("131683881869317@lid"), "Mary Bauer");
});

test("Tammy case: 1-token saved name resolves correctly via alias", () => {
  storeContact({
    jid: "210444891463794@lid",
    name: null,
    notify: "TamTam",
  });
  storeContact({
    jid: "4917697335710@s.whatsapp.net",
    name: "Tammy",
    notify: null,
  });
  storeLidAlias("210444891463794@lid", "4917697335710@s.whatsapp.net");

  assert.equal(displayName("210444891463794@lid"), "Tammy");
});

test("storeLidAlias is idempotent: second call for same lid is a no-op", () => {
  storeContact({ jid: "4917697335710@s.whatsapp.net", name: "Tammy" });
  storeLidAlias("210444891463794@lid", "4917697335710@s.whatsapp.net");
  // Even if a different @s is passed in a second call, the first one wins
  // (INSERT OR IGNORE semantics).
  storeContact({ jid: "4900000000000@s.whatsapp.net", name: "Wrong Person" });
  storeLidAlias("210444891463794@lid", "4900000000000@s.whatsapp.net");

  storeContact({
    jid: "210444891463794@lid",
    name: null,
    notify: "TamTam",
  });
  // Should still resolve to Tammy, not Wrong Person.
  assert.equal(displayName("210444891463794@lid"), "Tammy");
});

test("storeLidAlias rejects malformed JIDs without throwing", () => {
  // Wrong order, missing @s, etc. — should silently skip.
  storeLidAlias("4917697335710@s.whatsapp.net", "210444891463794@lid");
  storeLidAlias("foo", "bar");
  storeLidAlias("210444891463794@lid", "no-domain");
  // No assertion needed — just ensure no exception thrown and no row.
  storeContact({ jid: "210444891463794@lid", name: null, notify: "TamTam" });
  assert.equal(displayName("210444891463794@lid"), "TamTam");
});

test("alias takes precedence over notify-string heuristics", () => {
  // Set up a misleading notify match: a different @s contact has the same
  // notify as the @lid contact, which the legacy heuristic would pick up.
  storeContact({
    jid: "131683881869317@lid",
    name: null,
    notify: "Mary Grace Bauer",
  });
  storeContact({
    jid: "4900000000000@s.whatsapp.net",
    name: "Wrong Match",
    notify: "Mary Grace Bauer",
  });
  storeContact({
    jid: "4917655263429@s.whatsapp.net",
    name: "Mary Bauer",
    notify: null,
  });
  // Without alias, the legacy heuristic would return "Wrong Match".
  // With alias, the deterministic JOIN takes precedence.
  storeLidAlias("131683881869317@lid", "4917655263429@s.whatsapp.net");
  assert.equal(displayName("131683881869317@lid"), "Mary Bauer");
});
