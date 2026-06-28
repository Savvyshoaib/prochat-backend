import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { db } from "@/db";
import { bots } from "@/db/schema";
import { conversations, messages } from "@/db/schema/conversations";
import { fail } from "@/utils/response";
import { streamAI } from "@/modules/chat/chat.routes";
import { env } from "@/config/env";

// The embeddable widget script — all logic here, snippet is just 2 lines on the user's site.
// Backend URL is derived from the script's own src (document.currentScript.src).
// Frontend URL is injected at build time from env.
function buildWidgetScript(): string {
  const frontendUrl = env.FRONTEND_URL;
  return `(function(){
  var s=document.currentScript;
  var botId=s&&s.dataset.botId||window._helixBotId;
  if(!botId){console.warn("HelixAI: add data-bot-id to the script tag");return;}
  var apiBase=s?s.src.replace(/\\/widget\\.js.*/,""):"${env.BETTER_AUTH_URL}";
  var fr=document.createElement("iframe");
  fr.src="${frontendUrl}/widget/"+botId;
  fr.id="helix-widget-frame";
  fr.allow="microphone";
  fr.style.cssText="position:fixed;bottom:90px;right:20px;width:380px;height:580px;border:none;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.18);z-index:2147483646;display:none;";
  document.body.appendChild(fr);
  var btn=document.createElement("button");
  btn.title="Chat with us";
  btn.style.cssText="position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,0.25);z-index:2147483647;background:#4f46e5;transition:transform .2s;";
  btn.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  fetch(apiBase+"/api/widget/"+botId).then(function(r){return r.json();}).then(function(b){
    if(b.brandColor)btn.style.background=b.brandColor;
    var iconUrl=b.bubbleIconUrl||b.logoUrl;
    if(iconUrl){
      btn.style.background="transparent";
      btn.style.boxShadow="none";
      btn.style.padding="0";
      btn.innerHTML='<img src="'+iconUrl+'" style="width:56px;height:56px;object-fit:cover;border-radius:50%;display:block;" />';
    }
  }).catch(function(){});
  document.body.appendChild(btn);
  var open=false;
  function setOpen(val){open=val;fr.style.display=open?"block":"none";btn.style.transform=open?"rotate(90deg)":"";}
  btn.onclick=function(){setOpen(!open);};
  window.addEventListener("message",function(e){if(e.data&&e.data.type==="helix-close"){setOpen(false);}});
})();`;
}

function newId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

const widgetChatSchema = z.object({
  botId: z.string().min(1),
  message: z.string().min(1).max(4000),
  conversationId: z.string().nullish(),
  sessionId: z.string().nullish(), // anonymous visitor session
});

export async function widgetRoutes(app: FastifyInstance) {
  // GET /widget.js — the embeddable script (served publicly)
  app.get("/widget.js", async (_request, reply) => {
    reply
      .header("Content-Type", "application/javascript; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .header("Access-Control-Allow-Origin", "*")
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("Cross-Origin-Embedder-Policy", "unsafe-none")
      .send(buildWidgetScript());
  });

  // GET /api/widget/:botId — public bot info (for widget to show name/color/welcome)
  app.get("/api/widget/:botId", async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    if (bot.status !== "Live") return reply.status(403).send(fail("Bot is not live"));

    return reply
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .send({
        id: bot.id,
        name: bot.name,
        welcomeMessage: bot.welcomeMessage,
        brandColor: bot.brandColor,
        logoUrl: bot.logoUrl,
        chatBubbleIcon: bot.chatBubbleIcon,
        bubbleIconUrl: bot.bubbleIconUrl,
        chatPosition: bot.chatPosition,
        footerText: bot.footerText,
        tone: bot.tone,
        language: bot.language,
      });
  });

  // POST /api/widget/chat — public SSE chat (no auth, uses sessionId for anonymous visitors)
  app.post("/api/widget/chat", async (request, reply) => {
    const parsed = widgetChatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(fail("Invalid request", parsed.error.flatten().fieldErrors));
    }

    const { botId, message, conversationId, sessionId } = parsed.data;

    // ── 1. Fetch bot + history in parallel ───────────────────────────────────
    const [botResult, existingHistory] = await Promise.all([
      db.select().from(bots).where(eq(bots.id, botId)).limit(1),
      conversationId
        ? db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)).limit(20)
        : Promise.resolve([]),
    ]);

    const [bot] = botResult;
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    if (bot.status !== "Live") return reply.status(403).send(fail("Bot is not live"));

    // ── 2. Prepare conv ID + fire-and-forget DB writes ───────────────────────
    const convId_final = conversationId ?? `conv_${newId()}`;
    const dbWritePromise = (async () => {
      if (!conversationId) {
        await db.insert(conversations).values({ id: convId_final, botId, userId: null, sessionId: sessionId ?? null, title: message.slice(0, 60) });
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
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": "true",
    });
    reply.hijack();

    let fullReply = "";

    // Build system prompt
    const parts: string[] = [];
    if (bot.persona) parts.push(`You are ${bot.persona}.`);
    else parts.push(`You are ${bot.name || "a helpful AI assistant"}.`);
    parts.push(`Always communicate in a ${bot.tone.toLowerCase()} tone.`);
    parts.push(`Always format your responses using proper Markdown:\n- Use ## or ### for section headings\n- Use - or * for bullet point lists (never use | as separator)\n- Use **bold** only for key terms, never for entire lines\n- Add a blank line between sections\n- Keep each bullet point on its own line\n- Never write multiple items separated by | on one line\n- Never write everything as one long paragraph`);
    if (bot.instructions) parts.push(bot.instructions);
    if (bot.knowledgeText?.trim()) {
      parts.push(`\n## Knowledge Base\nAnswer using ONLY the following information. If the answer is not here, say "I don't have that information" — never fabricate.\n\n${bot.knowledgeText}`);
    }
    parts.push(`\nLanguage rule: Always mirror the exact language and script the user writes in. If the user writes in Roman Urdu (Urdu words spelled in English letters, e.g. "apka name kia hai"), reply in Roman Urdu. If they write in English, reply in English. If they write in Urdu script, reply in Urdu script. Never switch scripts — match the user exactly. Default language if unclear: ${bot.language}.`);
    const systemPrompt = parts.join("\n\n");

    // Batch tokens — flush every 20ms
    let buffer = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (buffer) { res.write(`data: ${JSON.stringify({ text: buffer })}\n\n`); fullReply += buffer; buffer = ""; }
      flushTimer = null;
    };
    const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, 20); };

    try {
      const gen = streamAI(systemPrompt, existingHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), message);
      for await (const chunk of gen) { buffer += chunk; scheduleFlush(); }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush();
    } catch (err: unknown) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[widget] stream error:", msg);
      const friendlyMsg = "I'm having trouble responding right now. Please try again in a moment.";
      fullReply = friendlyMsg;
      res.write(`data: ${JSON.stringify({ text: friendlyMsg })}\n\n`);
    } finally {
      await dbWritePromise.catch(() => {});
      if (fullReply) {
        await db.insert(messages).values({
          id: `msg_${newId()}`,
          conversationId: convId_final,
          role: "assistant",
          content: fullReply,
        });
        await db
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, convId_final));
      }
      res.write(`data: ${JSON.stringify({ done: true, conversationId: convId_final })}\n\n`);
      res.end();
    }
  });
}
