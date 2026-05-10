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

test("saved name returned when present and != push name", () => {
  assert.equal(
    pickSenderDisplay(opts({ savedName: "Joe Beck", pushName: "🔥 Joe 🔥" })),
    "Joe Beck",
  );
});

test("Mary Bauer case: saved name == push name → fuzzy upgrade", () => {
  // The view fell through to notify, so saved_name = "Mary Grace Bauer"
  // (which is also the pushName). Fuzzy must run and find "Mary Bauer".
  let fuzzyCalls = 0;
  const display = pickSenderDisplay(
    opts({
      savedName: "Mary Grace Bauer",
      pushName: "Mary Grace Bauer",
      fuzzy: (push) => {
        fuzzyCalls++;
        assert.equal(push, "Mary Grace Bauer");
        return { name: "Mary Bauer" };
      },
    }),
  );
  assert.equal(display, "Mary Bauer");
  assert.equal(fuzzyCalls, 1);
});

test("notify-fallback signal is case-insensitive and trim-tolerant", () => {
  let calls = 0;
  pickSenderDisplay(
    opts({
      savedName: "  TamTam  ",
      pushName: "tamtam",
      fuzzy: () => {
        calls++;
        return null;
      },
    }),
  );
  assert.equal(calls, 1, "fuzzy should still be called despite casing/whitespace");
});

test("notify-fallback + fuzzy returns null → falls back to push name", () => {
  // Tammy case: saved 'Tammy' has 1 token → fuzzy refuses to match → use push name.
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

test("real saved name beats fuzzy when not in notify-fallback shape", () => {
  let calls = 0;
  const display = pickSenderDisplay(
    opts({
      savedName: "Alice",
      pushName: "Different Name",
      fuzzy: () => {
        calls++;
        return { name: "Whatever" };
      },
    }),
  );
  assert.equal(display, "Alice");
  assert.equal(calls, 0, "fuzzy must not run when saved name is genuine");
});
