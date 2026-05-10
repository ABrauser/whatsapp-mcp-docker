import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  type proto,
  isJidGroup,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import P from "pino";
import path from "node:path";

import {
  initializeDatabase,
  storeMessage,
  storeMessagesBatch,
  storeChat,
  storeContact,
  debugLidMapping,
  scheduleLidMigration,
  type Message as DbMessage,
} from "./database.ts";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR
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
      holder.sock.ev.removeAllListeners("creds.update");
      holder.sock.end(undefined);
    } catch { /* ignore */ }
    holder.sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
  });

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
      messages.forEach((msg) => {
        if (msg.pushName && !msg.key.fromMe) {
          const sJid = msg.key.participant ?? msg.key.remoteJid;
          if (sJid && sJid.endsWith("@s.whatsapp.net")) {
            const norm = jidNormalizedUser(sJid);
            if (!pushNameMap.has(norm)) pushNameMap.set(norm, msg.pushName);
          }
        }
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
        if (group.id && group.subject) {
          storeChat({ jid: group.id, name: group.subject });
          logger.info(`[Group] Upserted name: "${group.subject}" for ${group.id}`);
        }
      }
    }

    if (events["groups.update"]) {
      for (const update of events["groups.update"]) {
        if (update.id && update.subject) {
          storeChat({ jid: update.id, name: update.subject });
          logger.info(`[Group] Updated name: "${update.subject}" for ${update.id}`);
        }
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
    const result = await sock.sendMessage(normalizedJid, { text: text });
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}
