import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { whatsappSessions } from "@/db/schema/whatsapp";
import { bots } from "@/db/schema/bots";
import { authenticate } from "@/middleware/authenticate";
import { ok, fail } from "@/utils/response";
import {
  startSession,
  deleteSession,
  registerSseClient,
  unregisterSseClient,
} from "./session-manager";

function newId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function whatsappRoutes(app: FastifyInstance) {

  // ── POST /api/whatsapp/connect ─────────────────────────────────────────────
  // Creates a new session + kicks off Baileys QR flow.
  // Body: { botId: string }
  app.post("/api/whatsapp/connect", { preHandler: authenticate }, async (request, reply) => {
    const { botId } = request.body as { botId?: string };

    if (!botId) {
      return reply.status(400).send(fail("botId is required"));
    }

    // Verify bot ownership
    const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    if (!bot || bot.userId !== request.user.id) {
      return reply.status(403).send(fail("Bot not found"));
    }

    // Disconnect any existing session for this bot
    const [existing] = await db
      .select()
      .from(whatsappSessions)
      .where(
        and(
          eq(whatsappSessions.botId, botId),
          eq(whatsappSessions.userId, request.user.id)
        )
      )
      .limit(1);

    if (existing) {
      await deleteSession(existing.sessionId).catch(() => {});
      await db
        .update(whatsappSessions)
        .set({ status: "PENDING", qrCode: "", updatedAt: new Date() })
        .where(eq(whatsappSessions.id, existing.id));
    }

    // Create fresh session record
    const sessionId = `wa_${newId()}`;
    const id = `wses_${newId()}`;

    await db.insert(whatsappSessions).values({
      id,
      userId: request.user.id,
      botId,
      sessionId,
      status: "PENDING",
    });

    // Start Baileys in background — QR will arrive via SSE
    startSession(sessionId, botId).catch((err) =>
      console.error("[WA] startSession error:", err)
    );

    return reply.send(ok({ sessionId, status: "PENDING" }));
  });

  // ── GET /api/whatsapp/events/:sessionId ────────────────────────────────────
  // SSE stream — frontend connects here to receive QR + status events.
  // Events: qr | connected | status
  app.get("/api/whatsapp/events/:sessionId", { preHandler: authenticate }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    // Ownership check
    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(
        and(
          eq(whatsappSessions.sessionId, sessionId),
          eq(whatsappSessions.userId, request.user.id)
        )
      )
      .limit(1);

    if (!session) {
      return reply.status(403).send(fail("Session not found"));
    }

    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": request.headers.origin ?? "*",
      "Access-Control-Allow-Credentials": "true",
    });
    reply.hijack();

    const client = {
      write: (data: string) => { try { res.write(data); } catch { /* ignore */ } },
      end: () => { try { res.end(); } catch { /* ignore */ } },
    };

    registerSseClient(sessionId, client);

    // Send current state immediately so the client doesn't have to wait
    const currentData = `event: init\ndata: ${JSON.stringify({
      status: session.status,
      qrCode: session.qrCode ?? "",
      phoneNumber: session.phoneNumber ?? "",
      displayName: session.displayName ?? "",
    })}\n\n`;
    client.write(currentData);

    // Send heartbeat every 20s to keep connection alive
    const heartbeat = setInterval(() => {
      client.write(": ping\n\n");
    }, 20000);

    res.on("close", () => {
      clearInterval(heartbeat);
      unregisterSseClient(sessionId, client);
    });
  });

  // ── GET /api/whatsapp/status/:sessionId ───────────────────────────────────
  // Polling fallback — returns current session status.
  app.get("/api/whatsapp/status/:sessionId", { preHandler: authenticate }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(
        and(
          eq(whatsappSessions.sessionId, sessionId),
          eq(whatsappSessions.userId, request.user.id)
        )
      )
      .limit(1);

    if (!session) {
      return reply.status(404).send(fail("Session not found"));
    }

    return reply.send(ok({
      sessionId: session.sessionId,
      status: session.status,
      phoneNumber: session.phoneNumber,
      displayName: session.displayName,
      qrCode: session.qrCode,
      connectedAt: session.connectedAt,
      lastSeen: session.lastSeen,
    }));
  });

  // ── GET /api/whatsapp/sessions ────────────────────────────────────────────
  // Returns all WhatsApp sessions for the current user.
  app.get("/api/whatsapp/sessions", { preHandler: authenticate }, async (request, reply) => {
    const sessions = await db
      .select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.userId, request.user.id));

    return reply.send(ok(
      sessions.map((s) => ({
        id: s.id,
        sessionId: s.sessionId,
        botId: s.botId,
        status: s.status,
        phoneNumber: s.phoneNumber,
        displayName: s.displayName,
        connectedAt: s.connectedAt,
        lastSeen: s.lastSeen,
      }))
    ));
  });

  // ── DELETE /api/whatsapp/disconnect/:sessionId ────────────────────────────
  // Logs out + destroys session.
  app.delete("/api/whatsapp/disconnect/:sessionId", { preHandler: authenticate }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(
        and(
          eq(whatsappSessions.sessionId, sessionId),
          eq(whatsappSessions.userId, request.user.id)
        )
      )
      .limit(1);

    if (!session) {
      return reply.status(404).send(fail("Session not found"));
    }

    await deleteSession(sessionId);

    await db
      .delete(whatsappSessions)
      .where(eq(whatsappSessions.sessionId, sessionId));

    return reply.send(ok({ disconnected: true }));
  });

  // ── POST /api/whatsapp/reconnect/:sessionId ───────────────────────────────
  // Re-initiates QR flow for a disconnected session.
  app.post("/api/whatsapp/reconnect/:sessionId", { preHandler: authenticate }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(
        and(
          eq(whatsappSessions.sessionId, sessionId),
          eq(whatsappSessions.userId, request.user.id)
        )
      )
      .limit(1);

    if (!session) {
      return reply.status(404).send(fail("Session not found"));
    }

    await db
      .update(whatsappSessions)
      .set({ status: "PENDING", qrCode: "", updatedAt: new Date() })
      .where(eq(whatsappSessions.sessionId, sessionId));

    startSession(sessionId, session.botId).catch((err) =>
      console.error("[WA] reconnect error:", err)
    );

    return reply.send(ok({ sessionId, status: "PENDING" }));
  });
}
