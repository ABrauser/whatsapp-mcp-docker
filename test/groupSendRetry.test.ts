import { test, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  initializeDatabase,
  closeDatabase,
  storeChat,
  storeMessage,
} from "../src/database.ts";
import {
  cacheSentMessage,
  clearSentMessagesCache,
  resolveMessageForRetry,
  selectGroupSenderIdentity,
  filterOwnLidDeviceFromUSyncList,
} from "../src/whatsapp.ts";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-mcp-retry-test-"));
  process.env.WHATSAPP_MCP_DATA_DIR = tmpDir;
  initializeDatabase();
});

beforeEach(() => {
  clearSentMessagesCache();
});

after(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("resolveMessageForRetry: returns full proto.IMessage from memory cache when present", async () => {
  const payload = { extendedTextMessage: { text: "Cached group reply" } };
  cacheSentMessage("MSG-MEM-1", payload);

  const resolved = await resolveMessageForRetry({
    remoteJid: "120363407322586858@g.us",
    id: "MSG-MEM-1",
    fromMe: true,
  });

  assert.deepEqual(resolved, payload);
});

test("resolveMessageForRetry: falls back to SQLite message content when memory cache misses", async () => {
  const chatJid = "120363407322586858@g.us";
  storeChat({ jid: chatJid, name: "PiTStop CRM Team" });
  storeMessage({
    id: "MSG-DB-1",
    chat_jid: chatJid,
    sender: null,
    content: "Persisted message for retry",
    timestamp: new Date("2026-11-05T10:11:26Z"),
    is_from_me: true,
  });

  const resolved = await resolveMessageForRetry({
    remoteJid: chatJid,
    id: "MSG-DB-1",
    fromMe: true,
  });

  assert.deepEqual(resolved, { conversation: "Persisted message for retry" });
});

test("resolveMessageForRetry: returns undefined for unknown message ID", async () => {
  const resolved = await resolveMessageForRetry({
    remoteJid: "120363407322586858@g.us",
    id: "DOES-NOT-EXIST",
    fromMe: true,
  });

  assert.equal(resolved, undefined);
});

test("selectGroupSenderIdentity: uses meLid for @lid groups and meId for @s (pn) groups", () => {
  const meId = "491782326254:60@s.whatsapp.net";
  const meLid = "145930321932353:60@lid";

  assert.equal(
    selectGroupSenderIdentity({ addressingMode: "lid", meId, meLid }),
    meLid,
  );
  assert.equal(
    selectGroupSenderIdentity({ addressingMode: undefined, meId, meLid }),
    meLid,
  );
  assert.equal(
    selectGroupSenderIdentity({ addressingMode: "pn", meId, meLid }),
    meId,
  );
  assert.equal(
    selectGroupSenderIdentity({ addressingMode: "lid", meId, meLid: null }),
    meId,
  );
});

test("filterOwnLidDeviceFromUSyncList: removes only our own companion device under meLid while keeping primary phone, other companion devices, and other participants", () => {
  const meId = "491782326254:60@s.whatsapp.net";
  const meLid = "145930321932353:60@lid";

  const usyncList = [
    {
      id: "145930321932353@lid",
      devices: {
        deviceList: [
          { id: 0, keyIndex: 0 },
          { id: 60, keyIndex: 12 }, // our own Baileys companion device -> must be stripped
          { id: 67, keyIndex: 15 }, // our desktop WhatsApp -> must be kept
        ],
      },
    },
    {
      id: "64823991783564@lid",
      devices: {
        deviceList: [
          { id: 0, keyIndex: 0 },
          { id: 60, keyIndex: 3 }, // another user's device 60 -> must be kept
        ],
      },
    },
  ];

  const filtered = filterOwnLidDeviceFromUSyncList(usyncList, meId, meLid)!;
  assert.deepEqual(
    filtered[0].devices?.deviceList.map((d) => d.id),
    [0, 67],
  );
  assert.deepEqual(
    filtered[1].devices?.deviceList.map((d) => d.id),
    [0, 60],
  );
});
