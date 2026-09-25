/**
 * Regression guard for the Signal crypto core used by Baileys.
 *
 * `libsignal` (git dep of Baileys 6.x) pins protobufjs@6.8.8 which carries
 * critical advisories. package.json overrides it to the patched 7.x runtime
 * — the generated WhisperTextProtocol.js is only supposed to depend on the
 * stable `protobufjs/minimal` Reader/Writer API, but that assumption must
 * hold for every incoming WhatsApp message. This test does a full
 * PreKey → WhisperMessage roundtrip (incl. SessionRecord serialisation, i.e.
 * the same path `useMultiFileAuthState` takes) so a broken override fails
 * here instead of as "Bad MAC" in production logs.
 */
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";
import libsignal from "libsignal";

const { keyhelper, SessionBuilder, SessionCipher, ProtocolAddress, SessionRecord } = libsignal;

type KeyPair = { pubKey: Buffer; privKey: Buffer };

/** Minimal in-memory SignalStorage, mirroring what Baileys wires up. */
function makeStore() {
  const identity: KeyPair = keyhelper.generateIdentityKeyPair();
  const registrationId: number = keyhelper.generateRegistrationId();
  const preKey = keyhelper.generatePreKey(1);
  const signedPreKey = keyhelper.generateSignedPreKey(identity, 1);
  const sessions = new Map<string, unknown>();
  const preKeys = new Map<number, KeyPair>([[preKey.keyId, preKey.keyPair]]);

  return {
    identity,
    registrationId,
    bundle: {
      identityKey: identity.pubKey,
      registrationId,
      preKey: { keyId: preKey.keyId, publicKey: preKey.keyPair.pubKey },
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.keyPair.pubKey,
        signature: signedPreKey.signature,
      },
    },
    storage: {
      getOurIdentity: async () => identity,
      getOurRegistrationId: async () => registrationId,
      isTrustedIdentity: async () => true,
      loadPreKey: async (id: number) => preKeys.get(id),
      removePreKey: async (id: number) => void preKeys.delete(id),
      loadSignedPreKey: async () => signedPreKey.keyPair,
      // Serialize/deserialize like the on-disk auth state does.
      loadSession: async (addr: string) => {
        const raw = sessions.get(addr);
        return raw ? SessionRecord.deserialize(raw) : undefined;
      },
      storeSession: async (addr: string, record: InstanceType<typeof SessionRecord>) => {
        sessions.set(addr, JSON.parse(JSON.stringify(record.serialize())));
      },
    },
  };
}

test("libsignal: PreKey handshake + bidirectional WhisperMessage roundtrip", async () => {
  const alice = makeStore();
  const bob = makeStore();
  const aliceAddr = new ProtocolAddress("alice", 1);
  const bobAddr = new ProtocolAddress("bob", 1);

  // Alice bootstraps a session from Bob's public bundle.
  await new SessionBuilder(alice.storage, bobAddr).initOutgoing(bob.bundle);
  const aliceCipher = new SessionCipher(alice.storage, bobAddr);
  const bobCipher = new SessionCipher(bob.storage, aliceAddr);

  const first = await aliceCipher.encrypt(Buffer.from("hello bob"));
  assert.equal(first.type, 3, "first message must be a PreKeyWhisperMessage");
  const bobPlain = await bobCipher.decryptPreKeyWhisperMessage(first.body);
  assert.equal(Buffer.from(bobPlain).toString(), "hello bob");

  // Bob replies on the now-established session; ratchet must line up.
  const reply = await bobCipher.encrypt(Buffer.from("hi alice"));
  assert.equal(reply.type, 1, "reply must be a plain WhisperMessage");
  const alicePlain = await aliceCipher.decryptWhisperMessage(reply.body);
  assert.equal(Buffer.from(alicePlain).toString(), "hi alice");

  // A few more in each direction to step the chains.
  for (let i = 0; i < 5; i++) {
    const a = await aliceCipher.encrypt(Buffer.from(`a${i}`));
    assert.equal(Buffer.from(await bobCipher.decryptWhisperMessage(a.body)).toString(), `a${i}`);
    const b = await bobCipher.encrypt(Buffer.from(`b${i}`));
    assert.equal(Buffer.from(await aliceCipher.decryptWhisperMessage(b.body)).toString(), `b${i}`);
  }
});

test("libsignal: tampered ciphertext is rejected with Bad MAC", async () => {
  const alice = makeStore();
  const bob = makeStore();
  const aliceAddr = new ProtocolAddress("alice", 1);
  const bobAddr = new ProtocolAddress("bob", 1);

  await new SessionBuilder(alice.storage, bobAddr).initOutgoing(bob.bundle);
  const aliceCipher = new SessionCipher(alice.storage, bobAddr);
  const bobCipher = new SessionCipher(bob.storage, aliceAddr);
  // Complete the handshake in both directions so Alice drops pendingPreKey
  // and subsequent messages are plain WhisperMessages (type 1).
  await bobCipher.decryptPreKeyWhisperMessage((await aliceCipher.encrypt(Buffer.from("setup"))).body);
  await aliceCipher.decryptWhisperMessage((await bobCipher.encrypt(Buffer.from("ack"))).body);

  const msg = await aliceCipher.encrypt(Buffer.from("do not touch"));
  assert.equal(msg.type, 1);
  const tampered = Buffer.from(msg.body);
  tampered[tampered.length - 1] ^= 0xff; // WhisperMessage layout: [version][proto][8-byte MAC]

  // libsignal logs the per-session cause via console.error and throws a
  // generic SessionError — mirror that so the test documents what shows up
  // in production logs.
  const errorLog = mock.method(console, "error", () => {});
  try {
    await assert.rejects(
      () => bobCipher.decryptWhisperMessage(tampered),
      /No matching sessions found/,
    );
  } finally {
    errorLog.mock.restore();
  }
  const logged = errorLog.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(logged, /Bad MAC/);
});
