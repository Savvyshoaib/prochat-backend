import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bots } from "@/db/schema";
import type { CreateBotInput, UpdateBotInput } from "./bots.schema";

function newBotId(): string {
  return `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export const BotsService = {
  async listByUser(userId: string) {
    return db
      .select()
      .from(bots)
      .where(eq(bots.userId, userId))
      .orderBy(desc(bots.updatedAt));
  },

  async findById(id: string, userId: string) {
    const [bot] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, userId)))
      .limit(1);
    return bot ?? null;
  },

  async create(userId: string, data: CreateBotInput) {
    const id = data.id ?? newBotId();
    const [bot] = await db
      .insert(bots)
      .values({
        id,
        userId,
        name: data.name,
        description: data.description,
        language: data.language,
        tone: data.tone,
        persona: data.persona,
        instructions: data.instructions,
        welcomeMessage: data.welcomeMessage,
        brandColor: data.brandColor,
        logoUrl: data.logoUrl ?? "",
        chatBubbleIcon: data.chatBubbleIcon ?? "message",
        bubbleIconUrl: data.bubbleIconUrl ?? "",
        chatPosition: data.chatPosition ?? "bottom-right",
        footerText: data.footerText ?? "Powered by HelixAI",
        voice: data.voice,
        voiceSpeed: String(data.voiceSpeed),
        websiteUrl: data.websiteUrl,
        crawlDepth: data.crawlDepth,
        status: data.status,
        step: data.step,
        deployments: data.deployments,
        knowledgeFiles: data.knowledgeFiles,
        knowledgeText: data.knowledgeText ?? "",
      })
      .returning();
    return bot!;
  },

  async upsert(userId: string, data: CreateBotInput) {
    const id = data.id ?? newBotId();
    const existing = await BotsService.findById(id, userId);
    if (existing) {
      return BotsService.update(id, userId, data);
    }
    return BotsService.create(userId, { ...data, id });
  },

  async update(id: string, userId: string, data: UpdateBotInput) {
    const [bot] = await db
      .update(bots)
      .set({
        ...data,
        voiceSpeed: data.voiceSpeed !== undefined ? String(data.voiceSpeed) : undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(bots.id, id), eq(bots.userId, userId)))
      .returning();
    return bot ?? null;
  },

  async delete(id: string, userId: string) {
    const [deleted] = await db
      .delete(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, userId)))
      .returning();
    return deleted ?? null;
  },

  async duplicate(id: string, userId: string) {
    const original = await BotsService.findById(id, userId);
    if (!original) return null;
    const { createdAt, updatedAt, ...rest } = original;
    return BotsService.create(userId, {
      ...rest,
      id: undefined,
      name: `${rest.name} (copy)`,
      status: "Draft",
      voiceSpeed: Number(rest.voiceSpeed),
      deployments: rest.deployments as string[],
      knowledgeFiles: rest.knowledgeFiles as { name: string; size: string }[],
    });
  },
};
