import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/middleware/authenticate";
import { env } from "@/config/env";
import { fail } from "@/utils/response";

const generateSchema = z.object({
  field: z.enum(["behavior", "guardrails", "rules"]),
  botName: z.string().default(""),
  description: z.string().default(""),
  tone: z.string().default(""),
  persona: z.string().default(""),
});

const PROMPTS: Record<string, (ctx: { botName: string; description: string; tone: string; persona: string }) => string> = {
  behavior: (ctx) => `
You are helping set up an AI chatbot. Write a concise Behavior description (max 5-6 lines) for a chatbot with the following details:
- Bot name: ${ctx.botName || "AI Assistant"}
- Description: ${ctx.description || "A helpful assistant"}
- Tone: ${ctx.tone || "professional"}
- Persona: ${ctx.persona || "helpful assistant"}

The behavior should describe who the bot is, its role, and how it should interact with users.
Output ONLY the behavior text, no headings, no explanations, no markdown. Plain text, 5-6 lines max.
`.trim(),

  guardrails: (ctx) => `
You are helping set up an AI chatbot. Write concise Guardrails (max 5-6 lines) for a chatbot with the following details:
- Bot name: ${ctx.botName || "AI Assistant"}
- Description: ${ctx.description || "A helpful assistant"}
- Tone: ${ctx.tone || "professional"}
- Persona: ${ctx.persona || "helpful assistant"}

Guardrails are topics, actions, or behaviors the bot should avoid or restrict.
Output ONLY the guardrails text, no headings, no explanations, no markdown. Plain text, 5-6 lines max.
`.trim(),

  rules: (ctx) => `
You are helping set up an AI chatbot. Write concise Rules (max 5-6 lines) for a chatbot with the following details:
- Bot name: ${ctx.botName || "AI Assistant"}
- Description: ${ctx.description || "A helpful assistant"}
- Tone: ${ctx.tone || "professional"}
- Persona: ${ctx.persona || "helpful assistant"}

Rules are specific instructions the bot must always follow in every response.
Output ONLY the rules text, no headings, no explanations, no markdown. Plain text, 5-6 lines max.
`.trim(),
};

export async function generateRoutes(app: FastifyInstance) {
  app.post("/api/ai/generate", { preHandler: authenticate }, async (request, reply) => {
    if (!env.GEMINI_API_KEY) {
      return reply.status(503).send(fail("Gemini API key not configured"));
    }

    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(fail("Invalid request", parsed.error.flatten().fieldErrors));
    }

    const { field, botName, description, tone, persona } = parsed.data;
    const prompt = PROMPTS[field]({ botName, description, tone, persona });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[Gemini] error:", err);
      return reply.status(502).send(fail("Failed to generate content"));
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    return reply.send({ success: true, text });
  });
}
