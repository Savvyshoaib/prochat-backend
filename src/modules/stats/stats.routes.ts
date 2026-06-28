import type { FastifyInstance } from "fastify";
import { eq, sql, inArray } from "drizzle-orm";
import { authenticate } from "@/middleware/authenticate";
import { ok } from "@/utils/response";
import { db } from "@/db";
import { bots } from "@/db/schema";
import { conversations } from "@/db/schema/conversations";

export async function statsRoutes(app: FastifyInstance) {
  app.get("/api/stats", { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user.id;

    const [counts] = await db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        live: sql<number>`cast(count(*) filter (where status = 'Live') as int)`,
        paused: sql<number>`cast(count(*) filter (where status = 'Paused') as int)`,
        draft: sql<number>`cast(count(*) filter (where status = 'Draft') as int)`,
      })
      .from(bots)
      .where(eq(bots.userId, userId));

    // Real conversation count across all user's bots
    const [convCount] = await db
      .select({ total: sql<number>`cast(count(*) as int)` })
      .from(conversations)
      .where(eq(conversations.userId, userId));

    return reply.send(
      ok({
        totalBots: counts?.total ?? 0,
        liveBots: counts?.live ?? 0,
        pausedBots: counts?.paused ?? 0,
        draftBots: counts?.draft ?? 0,
        conversations: convCount?.total ?? 0,
        leads: 0,
        activeVisitors: 0,
        monthlyUsage: convCount?.total ?? 0,
        monthlyLimit: 20000,
      })
    );
  });
}
