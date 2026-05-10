import { test } from "node:test";
import { strict as assert } from "node:assert";
import { newTestDb, insertContact } from "./helpers.ts";
import {
  resolveByPushName,
  invalidateContactResolverCache,
} from "../src/contactResolver.ts";

test("resolveByPushName: empty input → null", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  assert.equal(resolveByPushName(null, db), null);
  assert.equal(resolveByPushName(undefined, db), null);
  assert.equal(resolveByPushName("", db), null);
  assert.equal(resolveByPushName("   ", db), null);
});

test("resolveByPushName: pushName with extra word matches saved name", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  insertContact(db, { jid: "4917655263429@s.whatsapp.net", name: "Mary Bauer" });
  insertContact(db, { jid: "131683881869317@lid", notify: "Mary Grace Bauer" });

  const r = resolveByPushName("Mary Grace Bauer", db);
  assert.deepEqual(r, { jid: "4917655263429@s.whatsapp.net", name: "Mary Bauer" });
});

test("resolveByPushName: identical pushName → exact match wins", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  insertContact(db, { jid: "1@s.whatsapp.net", name: "Tammy" });

  // Single-token names skip the fuzzy step entirely (token length < 2).
  // So this should NOT match.
  assert.equal(resolveByPushName("Tammy", db), null);
});

test("resolveByPushName: multi-token saved name matches multi-token pushName", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  insertContact(db, { jid: "1@s.whatsapp.net", name: "John Doe" });

  const r = resolveByPushName("John 🌟 Doe ✨", db);
  assert.deepEqual(r, { jid: "1@s.whatsapp.net", name: "John Doe" });
});

test("resolveByPushName: ambiguous → null (false-positive guard)", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  insertContact(db, { jid: "1@s.whatsapp.net", name: "John Doe" });
  insertContact(db, { jid: "2@s.whatsapp.net", name: "John Doe" });

  assert.equal(resolveByPushName("John Doe Junior", db), null);
});

test("resolveByPushName: pushName missing a token of saved name → no match", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  insertContact(db, { jid: "1@s.whatsapp.net", name: "Mary Grace Bauer" });

  // Saved name "Mary Grace Bauer" requires all three tokens. PushName "Mary
  // Bauer" only has two of them.
  assert.equal(resolveByPushName("Mary Bauer", db), null);
});

test("resolveByPushName: case-insensitive token match", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  insertContact(db, { jid: "1@s.whatsapp.net", name: "John Doe" });

  const r = resolveByPushName("JOHN doe", db);
  assert.deepEqual(r, { jid: "1@s.whatsapp.net", name: "John Doe" });
});

test("resolveByPushName: ignores @lid contacts as candidates", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  insertContact(db, { jid: "9@lid", name: "Mary Bauer" });

  // No @s.whatsapp.net candidate exists, even though an @lid one does.
  assert.equal(resolveByPushName("Mary Bauer Extra", db), null);
});

test("resolveByPushName: ignores @s contacts without saved name", () => {
  const db = newTestDb();
  invalidateContactResolverCache();
  insertContact(db, { jid: "1@s.whatsapp.net", notify: "Mary Bauer" });

  assert.equal(resolveByPushName("Mary Bauer Extra", db), null);
});

test("invalidateContactResolverCache: re-reads after change", () => {
  const db = newTestDb();
  invalidateContactResolverCache();

  // Initially nothing.
  assert.equal(resolveByPushName("John Doe", db), null);

  // Insert a candidate; cache is stale.
  insertContact(db, { jid: "1@s.whatsapp.net", name: "John Doe" });
  // Without invalidation, the cache still has the empty list.
  assert.equal(resolveByPushName("John Doe Junior", db), null);

  invalidateContactResolverCache();
  const r = resolveByPushName("John Doe Junior", db);
  assert.deepEqual(r, { jid: "1@s.whatsapp.net", name: "John Doe" });
});
