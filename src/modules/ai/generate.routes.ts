import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/middleware/authenticate";
import { env } from "@/config/env";
import { fail } from "@/utils/response";

// OpenRouter auto-routes to best available free model
const FREE_MODEL = "openrouter/free";

const generateSchema = z.object({
  field: z.enum(["behavior", "guardrails", "rules"]),
  botName: z.string().default(""),
  description: z.string().default(""),
  tone: z.string().default(""),
  persona: z.string().default(""),
});

const PROMPTS: Record<string, (ctx: { botName: string; description: string; tone: string; persona: string }) => string> = {
  behavior: (ctx) => `You are helping set up an AI chatbot. Write a concise Behavior description (max 5-6 lines) for a chatbot with these details:
- Bot name: ${ctx.botName || "AI Assistant"}
- Description: ${ctx.description || "A helpful assistant"}
- Tone: ${ctx.tone || "professional"}
- Persona: ${ctx.persona || "helpful assistant"}

The behavior should describe who the bot is, its role, and how it interacts with users.
Output ONLY the behavior text. No headings, no explanations, no markdown. Plain text, 5-6 lines max.`,

  guardrails: (ctx) => `You are helping set up an AI chatbot. Write concise Guardrails (max 5-6 lines) for a chatbot with these details:
- Bot name: ${ctx.botName || "AI Assistant"}
- Description: ${ctx.description || "A helpful assistant"}
- Tone: ${ctx.tone || "professional"}
- Persona: ${ctx.persona || "helpful assistant"}

Guardrails are topics, actions, or behaviors the bot should avoid or restrict.
Output ONLY the guardrails text. No headings, no explanations, no markdown. Plain text, 5-6 lines max.`,

  rules: (ctx) => `You are helping set up an AI chatbot. Write concise Rules (max 5-6 lines) for a chatbot with these details:
- Bot name: ${ctx.botName || "AI Assistant"}
- Description: ${ctx.description || "A helpful assistant"}
- Tone: ${ctx.tone || "professional"}
- Persona: ${ctx.persona || "helpful assistant"}

Rules are specific instructions the bot must always follow in every response.
Output ONLY the rules text. No headings, no explanations, no markdown. Plain text, 5-6 lines max.`,
};

export async function generateRoutes(app: FastifyInstance) {
  app.post("/api/ai/generate", { preHandler: authenticate }, async (request, reply) => {
    if (!env.OPENROUTER_API_KEY) {
      return reply.status(503).send(fail("OpenRouter API key not configured"));
    }

    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(fail("Invalid request", parsed.error.flatten().fieldErrors));
    }

    const { field, botName, description, tone, persona } = parsed.data;
    const prompt = PROMPTS[field]({ botName, description, tone, persona });

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": env.FRONTEND_URL,
        "X-Title": "HelixAI",
      },
      body: JSON.stringify({
        model: FREE_MODEL,
        max_tokens: 300,
        temperature: 0.7,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[Generate] OpenRouter error", res.status, err);
      return reply.status(502).send(fail("Failed to generate content. Please try again."));
    }

    const data = await res.json() as {
      choices?: { message?: { content?: string } }[]
    };

    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    return reply.send({ success: true, text });
  });
}
