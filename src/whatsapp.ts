import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  type WAMessageKey,
  type GroupMetadata,
  proto,
  isJidGroup,
  jidNormalizedUser,
  jidDecode,
  USyncQuery,
} from "@whiskeysockets/baileys";
import P from "pino";
import path from "node:path";

import {
  initializeDatabase,
  storeMessage,
  storeMessagesBatch,
  storeChat,
  storeContact,
  storeLidAlias,
  debugLidMapping,
  scheduleLidMigration,
  getMessageById,
  type Message as DbMessage,
} from "./database.ts";

// --- Sent-message cache & retry resolution (getMessage) -------------
// When recipients (especially in @lid groups) cannot decrypt a message with
// their cached SenderKey, their WhatsApp client sends a retry receipt. Baileys
// invokes `getMessage(key)` from `makeWASocket` to fetch the original
// `proto.IMessage` payload and re-encrypt it. Without `getMessage`, retries
// silently drop and the message stays at a single checkmark.
const MAX_SENT_MESSAGES_CACHE = 500;
const sentMessagesCache = new Map<string, proto.IMessage>();

export function cacheSentMessage(
  messageId: string | null | undefined,
  message: proto.IMessage | null | undefined,
): void {
  if (!messageId || !message) return;
  if (sentMessagesCache.has(messageId)) {
    sentMessagesCache.delete(messageId);
  } else if (sentMessagesCache.size >= MAX_SENT_MESSAGES_CACHE) {
    const oldestKey = sentMessagesCache.keys().next().value;
    if (oldestKey !== undefined) {
      sentMessagesCache.delete(oldestKey);
    }
  }
  sentMessagesCache.set(messageId, message);
}

export function clearSentMessagesCache(): void {
  sentMessagesCache.clear();
}

export async function resolveMessageForRetry(
  key: WAMessageKey,
  logger?: P.Logger,
): Promise<proto.IMessage | undefined> {
  const id = key?.id;
  if (!id) return undefined;

  const cached = sentMessagesCache.get(id);
  if (cached) {
    logger?.info({ msgId: id, remoteJid: key.remoteJid, source: "memory" }, "Resolved message for retry request");
    return cached;
  }

  const dbMsg = getMessageById(id);
  if (dbMsg?.content) {
    logger?.info({ msgId: id, remoteJid: key.remoteJid, source: "sqlite" }, "Resolved message for retry request");
    return { conversation: dbMsg.content };
  }

  logger?.warn({ msgId: id, remoteJid: key.remoteJid }, "Retry requested for unknown message ID");
  return undefined;
}

// --- Group metadata cache & Baileys 6.7.x @lid group workarounds ----
const groupMetadataCache = new Map<string, GroupMetadata>();

export function getCachedGroupMetadata(jid: string): GroupMetadata | undefined {
  return groupMetadataCache.get(jid);
}

export function setCachedGroupMetadata(jid: string, meta: GroupMetadata): void {
  groupMetadataCache.set(jid, meta);
}

/**
 * Baileys 6.7.x always passes `creds.me.id` (`<phone>:<device>@s.whatsapp.net`)
 * to `signalRepository.encryptGroupMessage`, even in `@lid` groups where
 * WhatsApp's server stamps the stanza with `participant="<lid>:<device>@lid"`
 * and `addressing_mode="lid"`. Recipients then look up the SenderKey under our
 * `@lid` identity and fail decryption if it was keyed under our `@s` identity.
 */
export function selectGroupSenderIdentity(opts: {
  addressingMode?: string | null;
  meId: string;
  meLid?: string | null;
}): string {
  const mode = opts.addressingMode ?? "lid";
  if (mode === "lid" && opts.meLid) {
    return opts.meLid;
  }
  return opts.meId;
}

/**
 * Baileys 6.7.x `extractDeviceJids` only compares `userResult.id` against
 * `creds.me.id` (phone number), not `creds.me.lid`. When querying participant
 * devices for a `@lid` group, our own `@lid` entry is in the USync response and
 * Baileys mistakenly includes our own companion device in the recipient list.
 * This helper strips our own `(myLidUser, myDevice)` entry while preserving our
 * primary phone (`device === 0`) and other companion devices (e.g. desktop).
 */
export function filterOwnLidDeviceFromUSyncList<
  T extends { id?: string; devices?: { deviceList?: Array<{ id: number }> } }
>(
  list: T[] | undefined,
  meId: string | undefined | null,
  meLid: string | undefined | null,
): T[] | undefined {
  if (!Array.isArray(list) || !meLid) return list;
  const decodedLid = jidDecode(meLid);
  const decodedMe = meId ? jidDecode(meId) : undefined;
  const myLidUser = decodedLid?.user;
  const myDevice = decodedLid?.device ?? decodedMe?.device;
  if (!myLidUser || myDevice === undefined) return list;

  return list.map((item) => {
    if (!item?.id || !Array.isArray(item.devices?.deviceList)) return item;
    const itemDecoded = jidDecode(item.id);
    if (itemDecoded?.user !== myLidUser) return item;
    return {
      ...item,
      devices: {
        ...item.devices,
        deviceList: item.devices.deviceList.filter((d) => d.id !== myDevice),
      },
    };
  });
}

let activeMeIdentity: { id?: string; lid?: string } = {};
let usyncPatched = false;
function ensureUSyncLidPatchInstalled(): void {
  if (usyncPatched) return;
  usyncPatched = true;
  const origParse = USyncQuery.prototype.parseUSyncQueryResult;
  USyncQuery.prototype.parseUSyncQueryResult = function (result: any) {
    const parsed = origParse.call(this, result);
    if (parsed && Array.isArray(parsed.list)) {
      parsed.list = filterOwnLidDeviceFromUSyncList(
        parsed.list,
        activeMeIdentity.id,
        activeMeIdentity.lid,
      ) as any;
    }
    return parsed;
  };
}

/**
 * Extract a deterministic @lid ↔ @s.whatsapp.net mapping from a Baileys
 * message key. Returns null if the key does not carry both forms.
 *
 * WhatsApp's protocol surfaces this in three different field pairs depending
 * on the message kind (group vs 1:1, history sync vs live). Try each in
 * order; first match wins.
 */
function extractLidAlias(
  key: WAMessage["key"] | undefined | null,
): { lid: string; s: string } | null {
  if (!key) return null;
  // Group messages: key.participant is the @lid, key.participantPn is the
  // matching @s.whatsapp.net JID.
  if (
    key.participant?.endsWith("@lid") &&
    key.participantPn?.endsWith("@s.whatsapp.net")
  ) {
    return { lid: jidNormalizedUser(key.participant), s: jidNormalizedUser(key.participantPn) };
  }
  // Some envelopes carry participantLid + participantPn explicitly.
  if (
    key.participantLid?.endsWith("@lid") &&
    key.participantPn?.endsWith("@s.whatsapp.net")
  ) {
    return { lid: jidNormalizedUser(key.participantLid), s: jidNormalizedUser(key.participantPn) };
  }
  // 1:1 chats use senderLid + senderPn for incoming messages from accounts
  // that are still on @lid.
  if (
    key.senderLid?.endsWith("@lid") &&
    key.senderPn?.endsWith("@s.whatsapp.net")
  ) {
    return { lid: jidNormalizedUser(key.senderLid), s: jidNormalizedUser(key.senderPn) };
  }
  return null;
}

export const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR
  ? path.resolve(process.env.WHATSAPP_AUTH_DIR)
  : path.join(import.meta.dirname, "..", "auth_info");

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage) {
    content = msg.message.imageMessage.caption
      ? `[Image] ${msg.message.imageMessage.caption}`
      : `[Image]`;
  } else if (msg.message.videoMessage) {
    content = msg.message.videoMessage.caption
      ? `[Video] ${msg.message.videoMessage.caption}`
      : `[Video]`;
  } else if (msg.message.documentMessage) {
    content = `[Document] ${
      msg.message.documentMessage.caption ||
      msg.message.documentMessage.fileName ||
      ""
    }`;
  } else if (msg.message.audioMessage) {
    content = msg.message.audioMessage.ptt ? `[Voice Note]` : `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage) {
    content = msg.message.locationMessage.address
      ? `[Location] ${msg.message.locationMessage.address}`
      : `[Location]`;
  } else if (msg.message.liveLocationMessage) {
    content = `[Live Location]`;
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.contactsArrayMessage) {
    content = `[Contacts] ${msg.message.contactsArrayMessage.contacts?.length ?? 0} contacts`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  } else if (msg.message.viewOnceMessage?.message || msg.message.viewOnceMessageV2?.message) {
    content = `[View Once]`;
  }

  if (!content) {
    return null;
  }

  let timestampSeconds: number;

  if (msg.messageTimestamp != null) {
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    timestampSeconds = Date.now() / 1000;
  }

  const timestamp = new Date(timestampSeconds * 1000);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  // For self-sent messages, normalize sender to null in 1:1 chats AND groups
  // so downstream `is_from_me` is the single source of truth for "Me".
  if (msg.key.fromMe) {
    senderJid = null;
  }

  // Always capture pushName as a sender-display fallback. Critical for
  // messages where Baileys omits key.participant (stickers, some media).
  const pushName =
    !msg.key.fromMe && typeof msg.pushName === "string" && msg.pushName.length > 0
      ? msg.pushName
      : null;

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    sender_push_name: pushName,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

export interface WhatsAppConnection {
  sock: WhatsAppSocket | null;
  keys?: ReturnType<typeof makeCacheableSignalKeyStore>;
}

let isShuttingDown = false;
let reconnectAttempts = 0;
let groupFetchPending = false;

export async function startWhatsAppConnection(
  logger: P.Logger,
  connectionHolder?: WhatsAppConnection,
  onLoggedOut?: () => void
): Promise<WhatsAppConnection> {
  // DB already initialized in main.ts; safe-no-op here
  initializeDatabase();

  if (process.env.WHATSAPP_DEBUG === "true") {
    debugLidMapping(logger);
  }

  const holder: WhatsAppConnection = connectionHolder || { sock: null };

  // Tear down previous socket if any (reconnect path)
  if (holder.sock) {
    try {
      holder.sock.ev.removeAllListeners("connection.update");
      holder.sock.ev.removeAllListeners("messages.upsert");
      holder.sock.ev.removeAllListeners("messaging-history.set");
      holder.sock.ev.removeAllListeners("chats.update");
      holder.sock.ev.removeAllListeners("contacts.upsert");
      holder.sock.ev.removeAllListeners("contacts.update");
      holder.sock.ev.removeAllListeners("groups.upsert");
      holder.sock.ev.removeAllListeners("groups.update");
      holder.sock.ev.removeAllListeners("group-participants.update");
      holder.sock.ev.removeAllListeners("creds.update");
      holder.sock.end(undefined);
    } catch { /* ignore */ }
    holder.sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  ensureUSyncLidPatchInstalled();
  activeMeIdentity = {
    id: state.creds.me?.id,
    lid: state.creds.me?.lid,
  };

  const cachedKeys = makeCacheableSignalKeyStore(state.keys, logger);
  holder.keys = cachedKeys;

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: cachedKeys,
    },
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => resolveMessageForRetry(key, logger),
    cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid),
  });

  // Patch signalRepository.encryptGroupMessage so @lid groups use creds.me.lid
  // instead of creds.me.id as the SenderKey author identity.
  const origEncryptGroupMessage = sock.signalRepository.encryptGroupMessage.bind(
    sock.signalRepository,
  );
  sock.signalRepository.encryptGroupMessage = async (opts) => {
    const groupMeta = groupMetadataCache.get(opts.group);
    const effectiveMeId = selectGroupSenderIdentity({
      addressingMode: (groupMeta as any)?.addressingMode ?? "lid",
      meId: opts.meId,
      meLid: state.creds.me?.lid,
    });
    return origEncryptGroupMessage({ ...opts, meId: effectiveMeId });
  };

  // Update the holder with the new socket
  holder.sock = sock;

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(qr)}&size=300`;
        // Raw QR data is sensitive (full session-pairing key valid for ~20s).
        // Keep it at debug so it's not in the default log file.
        logger.debug({ qrCodeData: qr }, "QR Code received.");
        logger.info("QR Code received. Scan with your WhatsApp app via the URL printed below.");
        // Log the QR URL prominently so it's visible in docker logs
        console.log("\n╔══════════════════════════════════════════════════════╗");
        console.log("║          SCAN QR CODE WITH WHATSAPP                 ║");
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log(`║  Open this URL in your browser:                     ║`);
        console.log(`║  ${qrUrl}`);
        console.log("╚══════════════════════════════════════════════════════╝\n");
      }

      if (connection === "close") {
        holder.sock = null;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          { error: lastDisconnect?.error },
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`
        );

        if (isShuttingDown) {
          logger.info("Shutdown in progress, skipping reconnection.");
          return;
        }

        if (statusCode !== DisconnectReason.loggedOut) {
          reconnectAttempts++;
          const delay = Math.min(Math.pow(2, reconnectAttempts) * 1000, 60000); // Exponential backoff capped at 60s
          logger.info(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);

          setTimeout(() => {
            if (!isShuttingDown) {
              startWhatsAppConnection(logger, holder, onLoggedOut).catch((err) =>
                logger.error({ err }, "Reconnect attempt failed")
              );
            }
          }, delay);
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          if (onLoggedOut) {
            onLoggedOut();
          } else {
            // Fallback if no shutdown handler wired up
            process.exit(1);
          }
        }
      } else if (connection === "open") {
        reconnectAttempts = 0; // Reset attempts on successful connection
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        console.log(`\n✅ WhatsApp connected as: ${sock.user?.name}\n`);

        // Fetch all group names once after connect (groupFetchAllParticipating is more
        // reliable than per-group groupMetadata, especially with the @LID protocol).
        // Guard against parallel fetches across reconnects.
        if (!groupFetchPending) {
          groupFetchPending = true;
          setTimeout(async () => {
            try {
              logger.info("Fetching all group names via groupFetchAllParticipating...");
              const allGroups = await sock.groupFetchAllParticipating();
              let resolved = 0;
              for (const [jid, meta] of Object.entries(allGroups)) {
                groupMetadataCache.set(jid, meta);
                if (meta.subject) {
                  storeChat({ jid, name: meta.subject });
                  resolved++;
                }
              }
              logger.info(`[Group] Resolved ${resolved} group names.`);
            } catch (err) {
              logger.warn({ err }, "Error fetching group names on startup");
            } finally {
              groupFetchPending = false;
            }
          }, 5000); // Wait 5s after connect to not overload the initial handshake
        } else {
          logger.debug("Group fetch already pending, skipping duplicate scheduling.");
        }
      }
    }

    if (events["creds.update"]) {
      activeMeIdentity = {
        id: state.creds.me?.id,
        lid: state.creds.me?.lid,
      };
      await saveCreds();
      logger.info("Credentials saved.");
    }

    const handleContacts = (contacts: any[]) => {
      for (const c of contacts) {
        if (c.id) {
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phoneNumber: (c as any).phoneNumber ?? null,
          });
        }
      }
      // Debounced: avoid scanning whole @lid table on every contacts batch.
      scheduleLidMigration();
    };

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages } =
        events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        handleContacts(contacts);
      }

      logger.info(`Storing ${chats.length} chats from history sync.`);
      chats.forEach((chat) =>
        storeChat({
          jid: chat.id,
          name: chat.name,
          last_message_time: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : undefined,
        })
      );

      const parsedMessages: DbMessage[] = [];
      // Collect distinct (jid, pushName) pairs from history so we can backfill
      // `notify` on @s.whatsapp.net contacts in one pass — this is what makes
      // the @lid → @s fuzzy-match work without any manual override.
      const pushNameMap = new Map<string, string>();
      const aliasMap = new Map<string, string>(); // lid -> s
      messages.forEach((msg) => {
        if (msg.pushName && !msg.key.fromMe) {
          const sJid = msg.key.participant ?? msg.key.remoteJid;
          if (sJid && sJid.endsWith("@s.whatsapp.net")) {
            const norm = jidNormalizedUser(sJid);
            if (!pushNameMap.has(norm)) pushNameMap.set(norm, msg.pushName);
          }
        }
        const a = extractLidAlias(msg.key);
        if (a && !aliasMap.has(a.lid)) aliasMap.set(a.lid, a.s);
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          parsedMessages.push(parsed);
        }
      });

      for (const [jid, notify] of pushNameMap) {
        storeContact({ jid, notify });
      }
      if (pushNameMap.size > 0) {
        logger.info(`[Auto-link] Captured pushName for ${pushNameMap.size} contacts from history sync.`);
      }

      for (const [lid, s] of aliasMap) {
        storeLidAlias(lid, s);
      }
      if (aliasMap.size > 0) {
        logger.info(`[Auto-link] Captured ${aliasMap.size} @lid → @s aliases from history sync.`);
      }

      if (parsedMessages.length > 0) {
        storeMessagesBatch(parsedMessages);
      }
      logger.info(`Stored ${parsedMessages.length} messages from history sync.`);
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          if (msg.key?.fromMe && msg.key?.id && msg.message) {
            cacheSentMessage(msg.key.id, msg.message);
          }
          // ── Capture deterministic @lid ↔ @s mapping from the envelope ────
          // WhatsApp ships both identifiers in every group message key.
          // Persisting the pair lets contacts_resolved deterministically link
          // the @lid contact to the user's saved address-book entry.
          const alias = extractLidAlias(msg.key);
          if (alias) {
            storeLidAlias(alias.lid, alias.s);
          }

          // ── Auto-link @lid ↔ @s.whatsapp.net via pushName ────────────
          // Every incoming message carries the sender's pushName. Store it
          // as `notify` on their @s.whatsapp.net contact row so the existing
          // fuzzy-match in getChats() can find their address-book name when
          // the same person appears under @lid in groups/status updates.
          if (msg.pushName && !msg.key.fromMe) {
            const senderJid = msg.key.participant ?? msg.key.remoteJid;
            if (senderJid && senderJid.endsWith("@s.whatsapp.net")) {
              storeContact({
                jid: jidNormalizedUser(senderJid),
                notify: msg.pushName,
              });
            }
          }

          const parsed = parseMessageForDb(msg);
          if (parsed) {
            // Content snippets are user data — keep them at debug only.
            logger.debug(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
                preview: parsed.content.substring(0, 50),
              },
              "Storing message"
            );
            storeMessage(parsed);
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)"
            );
          }
        }
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }

    // ─── Contact sync events (populate names over time) ────────────
    if (events["contacts.upsert"]) {
      const contacts = events["contacts.upsert"];
      logger.info(
        { count: contacts.length },
        "Received contacts.upsert event"
      );
      handleContacts(contacts);
    }

    if (events["contacts.update"]) {
      const contacts = events["contacts.update"];
      logger.info(
        { count: contacts.length },
        "Received contacts.update event"
      );
      handleContacts(contacts);
    }

    // ─── Group name sync events ─────────────────────────────────────
    if (events["groups.upsert"]) {
      for (const group of events["groups.upsert"]) {
        if (group.id) {
          groupMetadataCache.set(group.id, group);
        }
        if (group.id && group.subject) {
          storeChat({ jid: group.id, name: group.subject });
          logger.info(`[Group] Upserted name: "${group.subject}" for ${group.id}`);
        }
      }
    }

    if (events["groups.update"]) {
      for (const update of events["groups.update"]) {
        if (update.id) {
          groupMetadataCache.delete(update.id);
        }
        if (update.id && update.subject) {
          storeChat({ jid: update.id, name: update.subject });
          logger.info(`[Group] Updated name: "${update.subject}" for ${update.id}`);
        }
      }
    }

    if (events["group-participants.update"]) {
      const update = events["group-participants.update"];
      if (update?.id) {
        groupMetadataCache.delete(update.id);
      }
    }
  });

  return holder;
}

export function stopWhatsAppConnection(holder: WhatsAppConnection | null) {
  isShuttingDown = true;
  if (holder?.sock) {
    try {
      holder.sock.end(undefined);
    } catch (error) {
      // Ignore errors during end
    }
  }
}

// ─── Lazy group-name resolution ────────────────────────────────────
// MCP tools may surface groups whose name was not yet populated. Trigger a
// debounced background fetch so the next call returns enriched data.
let lazyGroupFetchTimer: NodeJS.Timeout | null = null;
let lazyGroupFetchInflight = false;
export function scheduleLazyGroupNameFetch(
  holder: WhatsAppConnection | null,
  logger: P.Logger,
  delayMs: number = 1500
): void {
  if (!holder?.sock?.user) return;
  if (lazyGroupFetchTimer) clearTimeout(lazyGroupFetchTimer);
  lazyGroupFetchTimer = setTimeout(async () => {
    lazyGroupFetchTimer = null;
    if (lazyGroupFetchInflight) return;
    const sock = holder.sock;
    if (!sock?.user) return;
    lazyGroupFetchInflight = true;
    try {
      const all = await sock.groupFetchAllParticipating();
      let updated = 0;
      for (const [jid, meta] of Object.entries(all)) {
        groupMetadataCache.set(jid, meta);
        if (meta.subject) {
          storeChat({ jid, name: meta.subject });
          updated++;
        }
      }
      if (updated > 0) {
        logger.info(`[Group] Lazy-fetch updated ${updated} group names.`);
      }
    } catch (err) {
      logger.warn({ err }, "Lazy group-name fetch failed");
    } finally {
      lazyGroupFetchInflight = false;
    }
  }, delayMs);
}

/**
 * Ensure group metadata is cached and, for @lid groups migrating from the old
 * phone-number SenderKey (`<group>::<phone>::<device>`) to the @lid SenderKey
 * (`<group>::<lid>::<device>`), reset `sender-key-memory` once so Baileys
 * distributes the new `senderKeyDistributionMessage` to all participants.
 */
async function prepareGroupForSend(
  sock: WhatsAppSocket,
  holder: WhatsAppConnection,
  groupJid: string,
  logger: P.Logger,
): Promise<void> {
  if (!isJidGroup(groupJid)) return;

  let meta = groupMetadataCache.get(groupJid);
  if (!meta) {
    try {
      meta = await sock.groupMetadata(groupJid);
      if (meta) {
        groupMetadataCache.set(groupJid, meta);
      }
    } catch (err) {
      logger.warn({ err, groupJid }, "Failed to prefetch group metadata before send");
    }
  }

  const meLid = sock.authState?.creds?.me?.lid;
  const keys = holder.keys ?? sock.authState?.keys;
  const addressingMode = (meta as any)?.addressingMode ?? "lid";
  if (addressingMode === "lid" && meLid && keys) {
    const decoded = jidDecode(meLid);
    if (decoded?.user) {
      const lidSenderKeyName = `${groupJid}::${decoded.user}::${decoded.device || 0}`;
      const existing = await keys.get("sender-key", [lidSenderKeyName]);
      if (!existing[lidSenderKeyName]) {
        logger.info(
          { groupJid, lidSenderKeyName },
          "Initializing @lid SenderKey for group; resetting sender-key-memory to force key distribution",
        );
        const selfSessionKey = `${decoded.user}.${decoded.device || 0}`;
        await keys.set({
          "sender-key-memory": { [groupJid]: null },
          session: { [selfSessionKey]: null },
        });
      }
    }
  }
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  holder: WhatsAppConnection | null,
  recipientJid: string,
  text: string
): Promise<proto.WebMessageInfo | void> {
  const sock = holder?.sock;
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send message: WhatsApp socket not connected or initialized."
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return;
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return;
  }

  try {
    logger.info(
      `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    await prepareGroupForSend(sock, holder, normalizedJid, logger);
    const result = await sock.sendMessage(normalizedJid, { text: text });
    if (result?.key?.id && result.message) {
      cacheSentMessage(result.key.id, result.message);
    }
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}

export async function editWhatsAppMessage(
  logger: P.Logger,
  holder: WhatsAppConnection | null,
  chatJid: string,
  messageId: string,
  newText: string,
): Promise<boolean> {
  const sock = holder?.sock;
  if (!sock || !sock.user) {
    logger.error("Cannot edit message: WhatsApp socket not connected or initialized.");
    return false;
  }
  if (!chatJid || !messageId) {
    logger.error("Cannot edit message: chatJid or messageId is missing.");
    return false;
  }
  if (!newText) {
    logger.error("Cannot edit message: New text is empty.");
    return false;
  }

  try {
    const normalizedJid = jidNormalizedUser(chatJid);
    await prepareGroupForSend(sock, holder, normalizedJid, logger);
    logger.info(
      { chatJid: normalizedJid, messageId },
      `Editing message: ${newText.substring(0, 50)}...`
    );
    const msgKey = {
      remoteJid: normalizedJid,
      id: messageId,
      fromMe: true,
    };
    const editPayload: proto.IMessage = {
      protocolMessage: {
        key: msgKey,
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        editedMessage: {
          conversation: newText,
        },
      },
    };
    await sock.relayMessage(normalizedJid, editPayload, {});
    cacheSentMessage(messageId, { conversation: newText });
    logger.info({ chatJid: normalizedJid, messageId }, "Message edited successfully");
    return true;
  } catch (error) {
    logger.error({ err: error, chatJid, messageId }, "Failed to edit message");
    return false;
  }
}

