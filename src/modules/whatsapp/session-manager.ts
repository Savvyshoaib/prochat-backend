import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import * as path from "path";
import * as fs from "fs";
import { db } from "@/db";
import { whatsappSessions } from "@/db/schema/whatsapp";
import { bots } from "@/db/schema/bots";
import { conversations, messages } from "@/db/schema/conversations";
import { eq, asc } from "drizzle-orm";
import { buildSystemPrompt, streamAI } from "@/modules/chat/chat.routes";

// ── Session file storage ───────────────────────────────────────────────────────
const SESSIONS_DIR = path.join(process.cwd(), "wa-sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

type WASocket = ReturnType<typeof makeWASocket>;

// ── In-memory state ────────────────────────────────────────────────────────────
const activeSockets = new Map<string, WASocket>();

// SSE client interface
interface SseClient {
  write: (data: string) => void;
  end: () => void;
}
const sseClients = new Map<string, Set<SseClient>>();

// ── SSE helpers ────────────────────────────────────────────────────────────────

export function registerSseClient(sessionId: string, client: SseClient): void {
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId)!.add(client);
}

export function unregisterSseClient(sessionId: string, client: SseClient): void {
  sseClients.get(sessionId)?.delete(client);
}

function broadcast(sessionId: string, event: string, data: unknown): void {
  const clients = sseClients.get(sessionId);
  if (!clients?.size) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.write(line); } catch { /* client disconnected */ }
  }
}

// ── ID generator ───────────────────────────────────────────────────────────────
function newId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// ── AI response collector ──────────────────────────────────────────────────────
async function generateAiReply(
  bot: typeof bots.$inferSelect,
  history: { role: "user" | "assistant"; content: string }[],
  userMessage: string
): Promise<string> {
  let reply = "";
  for await (const chunk of streamAI(buildSystemPrompt(bot), history, userMessage)) {
    reply += chunk;
  }
  return reply.trim() || "Sorry, I couldn't respond right now.";
}

// ── Incoming message handler ───────────────────────────────────────────────────
async function handleIncoming(
  sessionId: string,
  botId: string,
  from: string,
  text: string,
  sock: WASocket
): Promise<void> {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
  if (!bot || bot.status !== "Live") {
    console.log(`[WA] handleIncoming blocked: bot=${bot?.name ?? "not found"} status=${bot?.status ?? "N/A"}`);
    return;
  }
  console.log(`[WA] handleIncoming: bot="${bot.name}" knowledgeText=${bot.knowledgeText?.length ?? 0} chars`);

  // Use a stable session key per WhatsApp contact
  const sessionKey = `wa_${sessionId}_${from}`;

  let [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.sessionId, sessionKey))
    .limit(1);

  if (!conv) {
    const convId = `conv_${newId()}`;
    await db.insert(conversations).values({
      id: convId,
      botId: bot.id,
      userId: null,
      sessionId: sessionKey,
      title: text.slice(0, 60),
    });
    [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.sessionId, sessionKey))
      .limit(1);
  }

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(asc(messages.createdAt))
    .limit(20);

  await db.insert(messages).values({
    id: `msg_${newId()}`,
    conversationId: conv.id,
    role: "user",
    content: text,
  });

  const reply = await generateAiReply(
    bot,
    history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    text
  );

  await db.insert(messages).values({
    id: `msg_${newId()}`,
    conversationId: conv.id,
    role: "assistant",
    content: reply,
  });

  await db.update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conv.id));

  // Send reply back on WhatsApp
  await sock.sendMessage(from, { text: reply });

  // Update last seen on session
  await db.update(whatsappSessions)
    .set({ lastSeen: new Date() })
    .where(eq(whatsappSessions.sessionId, sessionId));
}

// ── Start / restore a session ──────────────────────────────────────────────────
export async function startSession(sessionId: string, botId: string | null): Promise<void> {
  // Tear down any existing socket for this session
  const old = activeSockets.get(sessionId);
  if (old) {
    try { old.end(undefined); } catch { /* ignore */ }
    activeSockets.delete(sessionId);
  }

  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  activeSockets.set(sessionId, sock);

  // ── Connection lifecycle ─────────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
        await db
          .update(whatsappSessions)
          .set({ status: "QR_READY", qrCode: qrDataUrl, updatedAt: new Date() })
          .where(eq(whatsappSessions.sessionId, sessionId));
        broadcast(sessionId, "qr", { qrCode: qrDataUrl, status: "QR_READY" });
      } catch (err) {
        console.error("[WA] QR generation failed:", err);
      }
    }

    if (connection === "open") {
      const user = sock.user;
      const phoneNumber = user?.id?.split(":")[0] ?? "";
      const displayName = user?.name ?? "";

      await db
        .update(whatsappSessions)
        .set({
          status: "CONNECTED",
          phoneNumber,
          displayName,
          qrCode: "",
          connectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(whatsappSessions.sessionId, sessionId));

      broadcast(sessionId, "connected", {
        status: "CONNECTED",
        phoneNumber,
        displayName,
      });
      console.log(`[WA] Session ${sessionId} connected — ${phoneNumber} (${displayName})`);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      activeSockets.delete(sessionId);
      console.log(`[WA] Session ${sessionId} closed. Code=${statusCode} loggedOut=${loggedOut}`);

      if (loggedOut) {
        await db
          .update(whatsappSessions)
          .set({ status: "DISCONNECTED", qrCode: "", updatedAt: new Date() })
          .where(eq(whatsappSessions.sessionId, sessionId));
        broadcast(sessionId, "status", { status: "DISCONNECTED" });
        // Wipe local auth files
        fs.rmSync(sessionPath, { recursive: true, force: true });
      } else {
        // Temporary drop — reconnect after a short delay
        broadcast(sessionId, "status", { status: "RECONNECTING" });
        setTimeout(() => {
          startSession(sessionId, botId).catch((err) =>
            console.error("[WA] Reconnect error:", err)
          );
        }, 4000);
      }
    }
  });

  // Persist auth credentials whenever they change
  sock.ev.on("creds.update", saveCreds);

  // ── Incoming message handler ─────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;
    if (!botId) return;

    for (const msg of msgs) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      if (!from || from.endsWith("@g.us")) continue; // skip group messages

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.imageMessage?.caption ??
        msg.message.videoMessage?.caption ??
        "";

      if (!text.trim()) continue;

      handleIncoming(sessionId, botId, from, text.trim(), sock).catch((err) =>
        console.error("[WA] handleIncoming error:", err)
      );
    }
  });
}

// ── Delete / logout session ────────────────────────────────────────────────────
export async function deleteSession(sessionId: string): Promise<void> {
  const sock = activeSockets.get(sessionId);
  if (sock) {
    try { await sock.logout(); } catch { /* ignore if already disconnected */ }
    activeSockets.delete(sessionId);
  }
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  fs.rmSync(sessionPath, { recursive: true, force: true });
}

export function getActiveSocket(sessionId: string): WASocket | null {
  return activeSockets.get(sessionId) ?? null;
}

// ── Forward widget message to bot owner's WhatsApp ─────────────────────────────
// Sends a self-notification so the owner sees widget conversations on WhatsApp.
export async function notifyOwnerViaWhatsApp(
  botId: string,
  visitorMessage: string,
  botReply: string
): Promise<void> {
  try {
    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.botId, botId))
      .limit(1);

    if (!session) {
      console.log(`[WA notify] No session found for botId=${botId}`);
      return;
    }
    if (session.status !== "CONNECTED") {
      console.log(`[WA notify] Session not connected (status=${session.status}) for botId=${botId}`);
      return;
    }

    const sock = activeSockets.get(session.sessionId);
    if (!sock) {
      console.log(`[WA notify] No active socket for sessionId=${session.sessionId} — trying to restore`);
      // Socket missing means server restarted but socket wasn't restored; skip silently
      return;
    }

    const ownerJid = `${session.phoneNumber}@s.whatsapp.net`;
    console.log(`[WA notify] Sending widget notification to ${ownerJid}`);

    const text =
      `🌐 *New widget message*\n\n` +
      `👤 *Visitor:* ${visitorMessage}\n\n` +
      `🤖 *Bot:* ${botReply}`;

    await sock.sendMessage(ownerJid, { text });
    console.log(`[WA notify] ✓ Sent to ${ownerJid}`);
  } catch (err) {
    console.error("[WA notify] Error:", err);
  }
}

// ── Restore all CONNECTED sessions on server start ────────────────────────────
export async function restoreAllSessions(): Promise<void> {
  try {
    const sessions = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.status, "CONNECTED"));

    if (!sessions.length) return;
    console.log(`[WA] Restoring ${sessions.length} WhatsApp session(s)...`);

    for (const session of sessions) {
      const authPath = path.join(SESSIONS_DIR, session.sessionId);
      if (fs.existsSync(authPath)) {
        console.log(`[WA] Restoring session ${session.sessionId} (botId=${session.botId})...`);
        startSession(session.sessionId, session.botId).catch((err) =>
          console.error(`[WA] Failed to restore ${session.sessionId}:`, err)
        );
      } else {
        console.log(`[WA] Auth files missing for ${session.sessionId} — marking DISCONNECTED`);
        await db
          .update(whatsappSessions)
          .set({ status: "DISCONNECTED", updatedAt: new Date() })
          .where(eq(whatsappSessions.sessionId, session.sessionId));
      }
    }
  } catch (err) {
    console.error("[WA] restoreAllSessions error:", err);
  }
}
