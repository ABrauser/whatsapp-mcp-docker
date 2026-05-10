import { test, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initContactOverrides,
  closeContactOverrides,
  getOverride,
  listOverrides,
} from "../src/contactOverrides.ts";

let tmpDir: string;
let overridesPath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wamcp-overrides-test-"));
  overridesPath = path.join(tmpDir, "contact_overrides.json");
});

after(() => {
  closeContactOverrides();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

beforeEach(() => {
  closeContactOverrides();
  try {
    fs.unlinkSync(overridesPath);
  } catch {
    // ignore
  }
});

test("getOverride: returns null when file is missing", () => {
  initContactOverrides(tmpDir);
  assert.equal(getOverride("anything@s.whatsapp.net"), null);
});

test("getOverride: returns mapped name when file present", () => {
  fs.writeFileSync(
    overridesPath,
    JSON.stringify({ "1@s.whatsapp.net": "Tammy" }),
  );
  initContactOverrides(tmpDir);
  assert.equal(getOverride("1@s.whatsapp.net"), "Tammy");
  assert.equal(getOverride("missing@s.whatsapp.net"), null);
});

test("getOverride: ignores non-string and empty values", () => {
  fs.writeFileSync(
    overridesPath,
    JSON.stringify({
      "ok@s.whatsapp.net": "Real",
      "empty@s.whatsapp.net": "   ",
      "bad@s.whatsapp.net": 42,
      "nested@s.whatsapp.net": { huh: 1 },
    }),
  );
  initContactOverrides(tmpDir);
  assert.equal(getOverride("ok@s.whatsapp.net"), "Real");
  assert.equal(getOverride("empty@s.whatsapp.net"), null);
  assert.equal(getOverride("bad@s.whatsapp.net"), null);
  assert.equal(getOverride("nested@s.whatsapp.net"), null);
});

test("getOverride: tolerates malformed JSON without crashing", () => {
  fs.writeFileSync(overridesPath, "{ this is not json");
  initContactOverrides(tmpDir);
  assert.equal(getOverride("anything"), null);
  assert.deepEqual(listOverrides(), {});
});

test("getOverride: trims surrounding whitespace from values", () => {
  fs.writeFileSync(
    overridesPath,
    JSON.stringify({ "1@s.whatsapp.net": "  Tammy  " }),
  );
  initContactOverrides(tmpDir);
  assert.equal(getOverride("1@s.whatsapp.net"), "Tammy");
});

test("getOverride: null/undefined input → null", () => {
  fs.writeFileSync(overridesPath, JSON.stringify({ a: "x" }));
  initContactOverrides(tmpDir);
  assert.equal(getOverride(null), null);
  assert.equal(getOverride(undefined), null);
});
