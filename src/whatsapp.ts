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
  storeChat,
  storeContact,
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
  } else if (msg.message.reactionMessage) {
    content = `[Reaction] ${msg.message.reactionMessage.text || ""}`;
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
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

let isShuttingDown = false;

export async function startWhatsAppConnection(
  logger: P.Logger
): Promise<WhatsAppSocket> {
  initializeDatabase();

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
    shouldIgnoreJid: (jid) => isJidGroup(jid),
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(qr)}&size=300`;
        logger.info(
          { qrCodeData: qr },
          "QR Code received. Scan with your WhatsApp app."
        );
        // Log the QR URL prominently so it's visible in docker logs
        console.log("\n╔══════════════════════════════════════════════════════╗");
        console.log("║          SCAN QR CODE WITH WHATSAPP                 ║");
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log(`║  Open this URL in your browser:                     ║`);
        console.log(`║  ${qrUrl}`);
        console.log("╚══════════════════════════════════════════════════════╝\n");
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`,
          lastDisconnect?.error
        );

        if (isShuttingDown) {
          logger.info("Shutdown in progress, skipping reconnection.");
          return;
        }

        if (statusCode !== DisconnectReason.loggedOut) {
          logger.info("Reconnecting...");
          startWhatsAppConnection(logger);
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        }
      } else if (connection === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        console.log(`\n✅ WhatsApp connected as: ${sock.user?.name}\n`);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages } =
        events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        contacts.forEach((c) =>
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phoneNumber: (c as any).phoneNumber ?? null,
          })
        );
        logger.info(`Stored ${contacts.length} contacts from history sync.`);
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

      let storedCount = 0;
      messages.forEach((msg) => {
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          storeMessage(parsed);
          storedCount++;
        }
      });
      logger.info(`Stored ${storedCount} messages from history sync.`);
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const parsed = parseMessageForDb(msg);
          if (parsed) {
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`
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
      for (const c of contacts) {
        storeContact({
          jid: c.id,
          name: c.name ?? null,
          notify: c.notify ?? null,
          phoneNumber: (c as any).phoneNumber ?? null,
        });
      }
    }

    if (events["contacts.update"]) {
      const contacts = events["contacts.update"];
      logger.info(
        { count: contacts.length },
        "Received contacts.update event"
      );
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
    }
  });

  return sock;
}

export function stopWhatsAppConnection(sock: WhatsAppSocket | null) {
  isShuttingDown = true;
  if (sock) {
    try {
      sock.end(undefined);
    } catch (error) {
      // Ignore errors during end
    }
  }
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  text: string
): Promise<proto.WebMessageInfo | void> {
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
