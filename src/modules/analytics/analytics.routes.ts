import type { FastifyInstance } from "fastify";
import { eq, sql, and, gte, lte } from "drizzle-orm";
import { authenticate } from "@/middleware/authenticate";
import { ok } from "@/utils/response";
import { db } from "@/db";
import { conversations } from "@/db/schema/conversations";

export async function analyticsRoutes(app: FastifyInstance) {
  // GET /api/analytics/conversations?range=daily|weekly|monthly&from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get("/api/analytics/conversations", { preHandler: authenticate }, async (request, reply) => {
    const { range = "daily", from, to } = request.query as {
      range?: "daily" | "weekly" | "monthly";
      from?: string;
      to?: string;
    };

    const userId = request.user.id;

    // Default date range: last 30 days for daily, last 12 weeks for weekly, last 12 months for monthly
    const now = new Date();
    let fromDate: Date;
    let toDate = to ? new Date(to) : new Date(now);
    toDate.setHours(23, 59, 59, 999);

    if (from) {
      fromDate = new Date(from);
    } else {
      fromDate = new Date(now);
      if (range === "daily") {
        fromDate.setDate(fromDate.getDate() - 29);
      } else if (range === "weekly") {
        fromDate.setDate(fromDate.getDate() - 7 * 11); // 12 weeks back
      } else {
        fromDate.setMonth(fromDate.getMonth() - 11); // 12 months back
      }
    }
    fromDate.setHours(0, 0, 0, 0);

    // Truncate to the right period and group
    let truncExpr: string;
    if (range === "daily") truncExpr = "day";
    else if (range === "weekly") truncExpr = "week";
    else truncExpr = "month";

    const trunc = sql.raw(`date_trunc('${truncExpr}', created_at)`);

    const rows = await db
      .select({
        period: sql<string>`to_char(${trunc}, 'YYYY-MM-DD')`,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          gte(conversations.createdAt, fromDate),
          lte(conversations.createdAt, toDate)
        )
      )
      .groupBy(trunc)
      .orderBy(trunc);

    // Fill in zeros for missing periods
    const filled = fillPeriods(rows, fromDate, toDate, range);

    return reply.send(ok({ range, from: fromDate.toISOString(), to: toDate.toISOString(), data: filled }));
  });
}

function fillPeriods(
  rows: { period: string; count: number }[],
  from: Date,
  to: Date,
  range: "daily" | "weekly" | "monthly"
): { period: string; count: number }[] {
  const map = new Map(rows.map((r) => [r.period, r.count]));
  const result: { period: string; count: number }[] = [];
  const cursor = new Date(from);

  while (cursor <= to) {
    const key = cursor.toISOString().slice(0, 10); // YYYY-MM-DD
    result.push({ period: key, count: map.get(key) ?? 0 });

    if (range === "daily") cursor.setDate(cursor.getDate() + 1);
    else if (range === "weekly") cursor.setDate(cursor.getDate() + 7);
    else cursor.setMonth(cursor.getMonth() + 1);
  }

  return result;
}
