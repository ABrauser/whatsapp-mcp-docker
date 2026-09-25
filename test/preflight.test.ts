/**
 * Startup preflight: the container runs as UID 1000, so root-owned bind
 * mounts must be detected before Baileys silently fails to persist keys.
 *
 * Permission bits behave differently per platform: Windows ignores chmod on
 * directories (files still honour the read-only attribute), and root bypasses
 * DAC checks entirely — those cases are skipped rather than faked.
 */
import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUnwritable } from "../src/preflight.ts";

const isRoot = process.getuid?.() === 0;
const isWindows = process.platform === "win32";
const all = () => true;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wamcp-preflight-"));
});
afterEach(() => {
  // Restore perms so cleanup works on every platform.
  for (const entry of fs.readdirSync(tmp, { recursive: true }) as string[]) {
    try { fs.chmodSync(path.join(tmp, entry), 0o644); } catch { /* ignore */ }
  }
  try { fs.chmodSync(tmp, 0o755); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("writable dir with writable files passes", () => {
  fs.writeFileSync(path.join(tmp, "creds.json"), "{}");
  fs.writeFileSync(path.join(tmp, "session-1.json"), "{}");
  assert.equal(findUnwritable(tmp, all), null);
});

test("missing dir is created and passes", () => {
  const dir = path.join(tmp, "nested", "auth_info");
  assert.equal(findUnwritable(dir, all), null);
  assert.ok(fs.statSync(dir).isDirectory());
});

test("read-only file inside an otherwise writable dir is reported (chown without -R)", { skip: isRoot }, () => {
  const good = path.join(tmp, "creds.json");
  const bad = path.join(tmp, "session-42.json");
  fs.writeFileSync(good, "{}");
  fs.writeFileSync(bad, "{}");
  fs.chmodSync(bad, 0o444);

  const result = findUnwritable(tmp, all);
  assert.ok(result, "expected a failure");
  assert.equal(result.path, bad);
  assert.match(result.code, /EACCES|EPERM/);
});

test("read-only files not selected by mustWrite are ignored", { skip: isRoot }, () => {
  fs.writeFileSync(path.join(tmp, "whatsapp.db"), "");
  const overrides = path.join(tmp, "contact_overrides.json");
  fs.writeFileSync(overrides, "{}");
  fs.chmodSync(overrides, 0o444);

  assert.equal(findUnwritable(tmp, (n) => n.startsWith("whatsapp.db")), null);
  assert.equal(findUnwritable(tmp, all)?.path, overrides);
});

test("unwritable dir itself is reported", { skip: isRoot || isWindows }, () => {
  const dir = path.join(tmp, "auth_info");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o555);

  const result = findUnwritable(dir, all);
  assert.ok(result);
  assert.equal(result.path, dir);
  assert.equal(result.code, "EACCES");
});
