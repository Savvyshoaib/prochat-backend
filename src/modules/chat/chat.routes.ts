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

/** Parse [SECTION]...[/SECTION] markers from instructions text */
function parseSection(text: string, tag: string): string {
  const m = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "i"));
  return m ? m[1].trim() : "";
}

export function buildSystemPrompt(bot: BotRow): string {
  const parts: string[] = [];

  // Parse structured instruction sections first
  const raw = bot.instructions ?? "";
  const behavior   = parseSection(raw, "BEHAVIOR");
  const guardrails = parseSection(raw, "GUARDRAILS");
  const rules      = parseSection(raw, "RULES");
  const plainFallback = !behavior && !guardrails && !rules ? raw.trim() : "";

  // ── PRIORITY 1: Guardrails & Rules (placed first so model weighs them highest) ──
  if (guardrails) {
    parts.push(`# GUARDRAILS — YOU MUST FOLLOW THESE WITHOUT EXCEPTION\n${guardrails}`);
  }

  if (rules) {
    parts.push(`# RULES — APPLY THESE IN EVERY SINGLE RESPONSE\n${rules}`);
  }

  // ── PRIORITY 2: Identity & Tone ──
  if (bot.persona) {
    parts.push(`You are ${bot.persona}.`);
  } else {
    parts.push(`You are ${bot.name || "a helpful AI assistant"}.`);
  }

  parts.push(`Tone: ${bot.tone.toLowerCase()}. Sound like a real, warm human — not a robot or AI assistant. Never start a response by stating your name repeatedly. Vary how you open each reply.`);

  // ── PRIORITY 3: Behavior ──
  if (behavior || plainFallback) {
    parts.push(`## How you should behave\n${behavior || plainFallback}`);
  }

  // ── PRIORITY 4: Lead capture (always active) ──
  parts.push(`## Lead Capture — IMPORTANT
When a user shows clear interest in a service or wants to move forward (e.g. "I want this", "how do we start", "what's the budget", "let's proceed"), naturally guide the conversation to collect their contact details.
Ask for: name, email, and phone number — one at a time, conversationally. Do NOT present a form or a list. Just ask naturally like a human would.
Example: "That sounds great! To get things started, could I get your name?" — then after they reply — "Perfect! And what's the best email to reach you on?"
Once you have their details, confirm you'll be in touch and thank them warmly.
Never skip this step when a user is ready to engage.`);

  // ── PRIORITY 5: Formatting ──
  parts.push(`## Response Format
- If the user asks for a table, use a proper Markdown table
- Otherwise use short paragraphs or bullet points — never a wall of text
- Keep responses concise and conversational unless detail is needed
- Always honor the user's requested format`);

  // ── PRIORITY 6: Knowledge Base ──
  if (bot.knowledgeText?.trim()) {
    parts.push(`## Knowledge Base\nUse the following information to answer questions. If something isn't covered here, say you'll find out and follow up — never make things up.\n\n${bot.knowledgeText}`);
  }

  // ── PRIORITY 7: Language ──
  parts.push(`## Language\nAlways reply in the same language and script the user uses. Roman Urdu → Roman Urdu. English → English. Urdu script → Urdu script. Never switch. Default: ${bot.language}.`);

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
