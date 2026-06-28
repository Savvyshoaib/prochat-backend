import type { FastifyInstance } from "fastify";
import { authenticate } from "@/middleware/authenticate";
import { ok, fail } from "@/utils/response";
import { BotsService } from "./bots.service";
import { createBotSchema, updateBotSchema, updateBotStatusSchema } from "./bots.schema";

export async function botsRoutes(app: FastifyInstance) {
  // All bot routes require auth
  app.addHook("preHandler", authenticate);

  // GET /api/bots
  app.get("/api/bots", async (request, reply) => {
    const botList = await BotsService.listByUser(request.user.id);
    return reply.send(ok(botList));
  });

  // POST /api/bots
  app.post("/api/bots", async (request, reply) => {
    const parsed = createBotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send(
        fail("Validation failed", parsed.error.flatten().fieldErrors as Record<string, string[]>)
      );
    }
    const bot = await BotsService.create(request.user.id, parsed.data);
    return reply.status(201).send(ok(bot, "Bot created successfully"));
  });

  // PUT /api/bots (upsert — used by wizard autosave)
  app.put("/api/bots", async (request, reply) => {
    const parsed = createBotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send(
        fail("Validation failed", parsed.error.flatten().fieldErrors as Record<string, string[]>)
      );
    }
    const bot = await BotsService.upsert(request.user.id, parsed.data);
    return reply.send(ok(bot));
  });

  // GET /api/bots/:id
  app.get<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const bot = await BotsService.findById(request.params.id, request.user.id);
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    return reply.send(ok(bot));
  });

  // PATCH /api/bots/:id
  app.patch<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const parsed = updateBotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send(
        fail("Validation failed", parsed.error.flatten().fieldErrors as Record<string, string[]>)
      );
    }
    const bot = await BotsService.update(request.params.id, request.user.id, parsed.data);
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    return reply.send(ok(bot, "Bot updated successfully"));
  });

  // DELETE /api/bots/:id
  app.delete<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const deleted = await BotsService.delete(request.params.id, request.user.id);
    if (!deleted) return reply.status(404).send(fail("Bot not found"));
    return reply.send(ok(null, "Bot deleted successfully"));
  });

  // POST /api/bots/:id/duplicate
  app.post<{ Params: { id: string } }>("/api/bots/:id/duplicate", async (request, reply) => {
    const copy = await BotsService.duplicate(request.params.id, request.user.id);
    if (!copy) return reply.status(404).send(fail("Bot not found"));
    return reply.status(201).send(ok(copy, "Bot duplicated successfully"));
  });

  // PATCH /api/bots/:id/status
  app.patch<{ Params: { id: string } }>("/api/bots/:id/status", async (request, reply) => {
    const parsed = updateBotStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send(fail("Invalid status value"));
    }
    const bot = await BotsService.update(request.params.id, request.user.id, {
      status: parsed.data.status,
    });
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    return reply.send(ok(bot, `Bot ${parsed.data.status.toLowerCase()}`));
  });
}
