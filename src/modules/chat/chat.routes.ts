import type { FastifyInstance } from "fastify";
import { z } from "zod";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { eq, asc } from "drizzle-orm";
import { db } from "@/db";
import { bots } from "@/db/schema/bots";
import { conversations, messages } from "@/db/schema/conversations";
import { authenticate } from "@/middleware/authenticate";
import { env } from "@/config/env";
import { fail } from "@/utils/response";

// ── Default models per provider ───────────────────────────────────────────────
const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
  openrouter: "openai/gpt-4o-mini",
};

export const activeModel = env.AI_MODEL ?? DEFAULT_MODELS[env.AI_PROVIDER] ?? "gpt-4o-mini";

// ── Lazy-initialized clients (only the active provider is used) ───────────────
function getOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: env.OPENAI_API_KEY! });
}

function getOpenRouterClient(): OpenAI {
  return new OpenAI({
    apiKey: env.OPENROUTER_API_KEY!,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": env.FRONTEND_URL,
      "X-Title": "HelixAI",
    },
  });
}

function getAnthropicClient(): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! });
}

// ── Unified streaming generator ───────────────────────────────────────────────
type ChatMsg = { role: "user" | "assistant"; content: string };

export async function* streamAI(
  systemPrompt: string,
  history: ChatMsg[],
  userMessage: string
): AsyncGenerator<string> {
  const allMessages: ChatMsg[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  if (env.AI_PROVIDER === "anthropic") {
    const client = getAnthropicClient();
    const stream = client.messages.stream({
      model: activeModel,
      max_tokens: 1024,
      system: systemPrompt,
      messages: allMessages,
    });
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  } else {
    // openai or openrouter — both use OpenAI SDK
    const client =
      env.AI_PROVIDER === "openrouter" ? getOpenRouterClient() : getOpenAIClient();

    const stream = await client.chat.completions.create({
      model: activeModel,
      stream: true,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...allMessages,
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? "";
      if (text) yield text;
    }
  }
}

// ── System prompt builder ─────────────────────────────────────────────────────
type BotRow = typeof bots.$inferSelect;

function buildSystemPrompt(bot: BotRow): string {
  const parts: string[] = [];

  if (bot.persona) {
    parts.push(`You are ${bot.persona}.`);
  } else {
    parts.push(`You are ${bot.name || "a helpful AI assistant"}.`);
  }

  parts.push(`Always communicate in a ${bot.tone.toLowerCase()} tone.`);

  if (bot.instructions) parts.push(bot.instructions);

  if (bot.knowledgeText?.trim()) {
    parts.push(
      `\n## Knowledge Base\nAnswer using ONLY the following information. ` +
        `If the answer is not here, say "I don't have that information" — never fabricate.\n\n${bot.knowledgeText}`
    );
  }

  parts.push(`\nAlways respond in ${bot.language}.`);
  return parts.join("\n\n");
}

function newId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────
const chatSchema = z.object({
  botId: z.string().min(1),
  message: z.string().min(1).max(4000),
  conversationId: z.string().nullish(),
});

export async function chatRoutes(app: FastifyInstance) {
  // POST /api/chat — SSE streaming
  app.post("/api/chat", { preHandler: authenticate }, async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(fail("Invalid request", parsed.error.flatten().fieldErrors));
    }

    const { botId, message, conversationId } = parsed.data;
    const userId = request.user.id;

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    if (bot.userId !== userId) return reply.status(403).send(fail("Forbidden"));

    let convId: string | null = conversationId ?? null;
    if (!convId) {
      convId = `conv_${newId()}`;
      await db.insert(conversations).values({
        id: convId, botId, userId,
        title: message.slice(0, 60),
      });
    }

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(asc(messages.createdAt))
      .limit(20);

    await db.insert(messages).values({
      id: `msg_${newId()}`,
      conversationId: convId,
      role: "user",
      content: message,
    });

    // SSE setup
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

    let fullReply = "";

    try {
      const gen = streamAI(
        buildSystemPrompt(bot),
        history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        message
      );

      for await (const chunk of gen) {
        fullReply += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[${env.AI_PROVIDER}] stream error:`, msg);
      res.write(`data: ${JSON.stringify({ error: `${env.AI_PROVIDER} error: ${msg}` })}\n\n`);
    } finally {
      if (fullReply) {
        await db.insert(messages).values({
          id: `msg_${newId()}`,
          conversationId: convId,
          role: "assistant",
          content: fullReply,
        });
        await db.update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, convId!));
      }
      res.write(`data: ${JSON.stringify({ done: true, conversationId: convId })}\n\n`);
      res.end();
    }
  });

  // GET /api/ai-provider — returns active provider info (no key exposed)
  app.get("/api/ai-provider", async (_request, reply) => {
    return reply.send({
      provider: env.AI_PROVIDER,
      model: activeModel,
    });
  });

  // GET /api/conversations?botId=xxx
  app.get("/api/conversations", { preHandler: authenticate }, async (request, reply) => {
    const { botId } = request.query as { botId?: string };
    if (!botId) return reply.status(400).send(fail("botId query param required"));

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    if (!bot || bot.userId !== request.user.id) return reply.status(403).send(fail("Forbidden"));

    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.botId, botId))
      .orderBy(asc(conversations.updatedAt))
      .limit(100);

    return reply.send({ success: true, data: convs });
  });

  // GET /api/conversations/:id/messages
  app.get("/api/conversations/:id/messages", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) return reply.status(404).send(fail("Conversation not found"));

    const [bot] = await db.select().from(bots).where(eq(bots.id, conv.botId)).limit(1);
    if (!bot || bot.userId !== request.user.id) return reply.status(403).send(fail("Forbidden"));

    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));

    return reply.send({ success: true, data: msgs });
  });
}
