import { test } from "node:test";
import { strict as assert } from "node:assert";
import { pickSenderDisplay } from "../src/mcp.ts";

/** Build the option bag with sane defaults so each test only sets what it cares about. */
function opts(over: Partial<Parameters<typeof pickSenderDisplay>[0]> = {}) {
  return {
    isFromMe: false,
    override: null,
    savedName: null,
    pushName: null,
    senderJid: null,
    fuzzy: () => null,
    ...over,
  };
}

test("isFromMe wins everything", () => {
  assert.equal(
    pickSenderDisplay(opts({ isFromMe: true, override: "X", savedName: "Y", pushName: "Z" })),
    "Me",
  );
});

test("override beats saved name", () => {
  assert.equal(
    pickSenderDisplay(opts({ override: "Manual", savedName: "Saved", pushName: "Push" })),
    "Manual",
  );
});

test("saved name returned when fuzzy finds no upgrade", () => {
  // savedName runs through fuzzy; with default mock returning null, the
  // savedName itself is returned unchanged.
  assert.equal(
    pickSenderDisplay(opts({ savedName: "Joe Beck", pushName: "🔥 Joe 🔥" })),
    "Joe Beck",
  );
});

test("Mary Bauer case: notify-fallback view + present pushName → fuzzy upgrade", () => {
  // Live message: view fell through to notify, savedName = pushName.
  // Fuzzy must find the unique saved "Mary Bauer" and return it.
  let fuzzyCalls = 0;
  const display = pickSenderDisplay(
    opts({
      savedName: "Mary Grace Bauer",
      pushName: "Mary Grace Bauer",
      fuzzy: (cand) => {
        fuzzyCalls++;
        assert.equal(cand, "Mary Grace Bauer");
        return { name: "Mary Bauer" };
      },
    }),
  );
  assert.equal(display, "Mary Bauer");
  assert.equal(fuzzyCalls, 1);
});

test("Mary Bauer regression: legacy message with NULL pushName still resolves", () => {
  // The bug we are fixing: old messages have sender_push_name=NULL because
  // they predate that column. Previously the looksLikeNotifyFallback
  // heuristic could not detect the notify-fallback shape and returned the
  // notify string verbatim. The new behavior: fuzzy ALWAYS runs on the
  // candidate, so the notify string is upgraded regardless of pushName.
  const display = pickSenderDisplay(
    opts({
      savedName: "Mary Grace Bauer",
      pushName: null,
      fuzzy: () => ({ name: "Mary Bauer" }),
    }),
  );
  assert.equal(display, "Mary Bauer");
});

test("Tammy fallback: 1-token saved name cannot be fuzzy-matched", () => {
  // Saved 'Tammy' has 1 token → fuzzy resolver refuses (false-positive guard).
  // Display falls back to whatever the view produced.
  const display = pickSenderDisplay(
    opts({
      savedName: "TamTam",
      pushName: "TamTam",
      fuzzy: () => null,
    }),
  );
  assert.equal(display, "TamTam");
});

test("no saved name, push name only → fuzzy attempted then push name", () => {
  let calls = 0;
  const display = pickSenderDisplay(
    opts({
      pushName: "Some Push Name",
      fuzzy: (push) => {
        calls++;
        assert.equal(push, "Some Push Name");
        return null;
      },
    }),
  );
  assert.equal(display, "Some Push Name");
  assert.equal(calls, 1);
});

test("no saved name, push name with successful fuzzy → fuzzy result", () => {
  const display = pickSenderDisplay(
    opts({
      pushName: "John Foo Doe",
      fuzzy: () => ({ name: "John Doe" }),
    }),
  );
  assert.equal(display, "John Doe");
});

test("no saved/push, only sender JID → JID prefix", () => {
  assert.equal(
    pickSenderDisplay(opts({ senderJid: "12345@s.whatsapp.net" })),
    "12345",
  );
});

test("no sender info at all → 'Unknown'", () => {
  assert.equal(pickSenderDisplay(opts()), "Unknown");
});

test("fuzzy is idempotent for genuine saved names: lookup returns same name", () => {
  // For a real saved address-book name, the fuzzy resolver returns a
  // self-match (savedName has ≥2 tokens and is the only contact whose
  // tokens are a subset of itself). The display equals savedName.
  const display = pickSenderDisplay(
    opts({
      savedName: "Alice Smith",
      pushName: "alice s",
      fuzzy: (cand) => {
        assert.equal(cand, "Alice Smith");
        return { name: "Alice Smith" };
      },
    }),
  );
  assert.equal(display, "Alice Smith");
});

test("savedName takes priority over pushName as the candidate", () => {
  // Even when both are set, fuzzy is run on savedName, not pushName.
  let received: string | null = null;
  pickSenderDisplay(
    opts({
      savedName: "Saved",
      pushName: "Push",
      fuzzy: (cand) => {
        received = cand;
        return null;
      },
    }),
  );
  assert.equal(received, "Saved");
});
