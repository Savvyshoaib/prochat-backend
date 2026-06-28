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

  // Default formatting rule (user can override via instructions/guardrails/rules)
  parts.push(`Always format your responses using proper Markdown:
- Use ## or ### for section headings
- Use - or * for bullet point lists (never use | as separator)
- Use **bold** only for key terms, never for entire lines
- Add a blank line between sections
- Keep each bullet point on its own line
- Never write multiple items separated by | on one line
- Never write everything as one long paragraph
Example of good format:
## Work Experience
**Senior Support Agent — ABC Solutions (2022–Present)**
- Assisted customers via email, chat, and phone
- Resolved technical issues efficiently`);

  if (bot.instructions) parts.push(bot.instructions);

  if (bot.knowledgeText?.trim()) {
    parts.push(
      `\n## Knowledge Base\nAnswer using ONLY the following information. ` +
        `If the answer is not here, say "I don't have that information" — never fabricate.\n\n${bot.knowledgeText}`
    );
  }

  parts.push(`\nLanguage rule: Always mirror the exact language and script the user writes in. If the user writes in Roman Urdu (Urdu words spelled in English letters, e.g. "apka name kia hai"), reply in Roman Urdu. If they write in English, reply in English. If they write in Urdu script, reply in Urdu script. Never switch scripts — match the user exactly. Default language if unclear: ${bot.language}.`);
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

    // ── 1. Fetch bot + existing history in parallel ───────────────────────────
    const [botResult, existingHistory] = await Promise.all([
      db.select().from(bots).where(eq(bots.id, botId)).limit(1),
      conversationId
        ? db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)).limit(20)
        : Promise.resolve([]),
    ]);

    const [bot] = botResult;
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    if (bot.userId !== userId) return reply.status(403).send(fail("Forbidden"));

    // ── 2. Prepare conversation — fire-and-forget DB writes ──────────────────
    let convId: string | null = conversationId ?? null;
    if (!convId) {
      convId = `conv_${newId()}`;
    }
    const convId_final = convId;

    // Insert conversation + user message in background (don't await)
    const dbWritePromise = (async () => {
      if (!conversationId) {
        await db.insert(conversations).values({ id: convId_final, botId, userId, title: message.slice(0, 60) });
      }
      await db.insert(messages).values({ id: `msg_${newId()}`, conversationId: convId_final, role: "user", content: message });
    })();

    // ── 3. Start streaming immediately ───────────────────────────────────────
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

    // Batch tokens — flush every 20ms instead of per-token to reduce write overhead
    let buffer = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (buffer) {
        res.write(`data: ${JSON.stringify({ text: buffer })}\n\n`);
        fullReply += buffer;
        buffer = "";
      }
      flushTimer = null;
    };
    const scheduleFlush = () => {
      if (!flushTimer) flushTimer = setTimeout(flush, 20);
    };

    try {
      const gen = streamAI(
        buildSystemPrompt(bot),
        existingHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        message
      );

      for await (const chunk of gen) {
        buffer += chunk;
        scheduleFlush();
      }
      // Flush remaining
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush();
    } catch (err: unknown) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[${env.AI_PROVIDER}] stream error:`, msg);
      const friendlyMsg = "I'm having trouble responding right now. Please try again in a moment.";
      fullReply = friendlyMsg;
      res.write(`data: ${JSON.stringify({ text: friendlyMsg })}\n\n`);
    } finally {
      // Wait for DB writes before saving assistant reply
      await dbWritePromise.catch(() => {});
      if (fullReply) {
        await db.insert(messages).values({
          id: `msg_${newId()}`,
          conversationId: convId_final,
          role: "assistant",
          content: fullReply,
        });
        await db.update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, convId_final));
      }
      res.write(`data: ${JSON.stringify({ done: true, conversationId: convId_final })}\n\n`);
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
