import "dotenv/config";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { env } from "@/config/env";
import { loggerConfig } from "@/utils/logger";
import { registerCors } from "@/plugins/cors";
import { registerErrorHandler } from "@/plugins/error-handler";
import { authRoutes } from "@/modules/auth/auth.routes";
import { usersRoutes } from "@/modules/users/users.routes";
import { botsRoutes } from "@/modules/bots/bots.routes";
import { statsRoutes } from "@/modules/stats/stats.routes";
import { chatRoutes } from "@/modules/chat/chat.routes";
import { knowledgeRoutes } from "@/modules/knowledge/knowledge.routes";
import { analyticsRoutes } from "@/modules/analytics/analytics.routes";
import { widgetRoutes } from "@/modules/widget/widget.routes";
import { generateRoutes } from "@/modules/ai/generate.routes";
import { voiceRoutes } from "@/modules/voice/voice.routes";
import { whatsappRoutes } from "@/modules/whatsapp/whatsapp.routes";
import { restoreAllSessions } from "@/modules/whatsapp/session-manager";

async function buildApp() {
  const app = Fastify({ logger: loggerConfig });

  // Security & cross-origin
  await app.register(helmet, { contentSecurityPolicy: false });
  await registerCors(app);
  await app.register(multipart);

  // Rate limiting
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      success: false,
      message: "Too many requests. Please slow down.",
    }),
  });

  // Error handling
  registerErrorHandler(app);

  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Routes
  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(botsRoutes);
  await app.register(statsRoutes);
  await app.register(chatRoutes);
  await app.register(knowledgeRoutes);
  await app.register(analyticsRoutes);
  await app.register(widgetRoutes);
  await app.register(generateRoutes);
  await app.register(voiceRoutes);
  await app.register(whatsappRoutes);

  return app;
}

async function start() {
  try {
    const app = await buildApp();
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    console.log(`Backend running on http://localhost:${env.PORT}`);
    console.log(`Health: http://localhost:${env.PORT}/health`);
    // Restore persisted WhatsApp sessions in background
    restoreAllSessions().catch((err) =>
      console.error("[WA] restoreAllSessions error:", err)
    );
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
