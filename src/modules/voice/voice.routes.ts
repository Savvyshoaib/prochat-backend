import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import { db } from "@/db";
import { bots } from "@/db/schema";
import { fail } from "@/utils/response";
import { env } from "@/config/env";

// Map UI voice labels → OpenAI TTS voice IDs
const VOICE_MAP: Record<string, OpenAI.Audio.SpeechCreateParams["voice"]> = {
  "Nova (Warm female)":         "nova",
  "Luna (Friendly female)":     "shimmer",
  "Atlas (Calm male)":          "onyx",
  "Orion (Authoritative male)": "echo",
};

// voiceSpeed 0-100  →  TTS speed 0.75-1.25
function mapSpeed(speed: number): number {
  return 0.75 + (Math.max(0, Math.min(100, speed)) / 100) * 0.5;
}

// ElevenLabs voice IDs — verified against this account's available voices
const ELEVENLABS_VOICE_MAP: Record<string, string> = {
  "Nova (Warm female)":         "EXAVITQu4vr4xnSDxMaL", // Sarah  — Mature, Reassuring
  "Luna (Friendly female)":     "cgSgspJ2msm6clMCkdW9",  // Jessica — Playful, Bright, Warm
  "Atlas (Calm male)":          "cjVigY5qzO86Huf0OWal",  // Eric   — Smooth, Trustworthy
  "Orion (Authoritative male)": "nPczCjzI2devNBz1zQrb",  // Brian  — Deep, Resonant
};

export async function voiceRoutes(app: FastifyInstance) {
  // ── POST /api/widget/voice/elevenlabs/:botId ──────────────────────────────
  // Creates an ElevenLabs Conversational AI signed URL. Bot's system prompt,
  // voice and first message are returned for the client to pass as session
  // overrides (ElevenLabs requires overrides to be sent by the connecting
  // client, not baked into the signed-url request).
  app.post("/api/widget/voice/elevenlabs/:botId", async (request, reply) => {
    const { botId } = request.params as { botId: string };

    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) {
      return reply.status(503).send(fail("ElevenLabs not configured. Add ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID to .env"));
    }

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    if (bot.status !== "Live") return reply.status(403).send(fail("Bot is not live"));

    const { buildSystemPrompt } = await import("@/modules/chat/chat.routes");
    const systemPrompt = buildSystemPrompt(bot);
    const voiceId = ELEVENLABS_VOICE_MAP[bot.voice ?? "Nova (Warm female)"] ?? "21m00Tcm4TlvDq8ikWAM";

    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${env.ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("[ElevenLabs] signed url failed:", res.status, err);
      return reply.status(502).send({ success: false, message: "Failed to create voice session", detail: err });
    }

    const data = (await res.json()) as { signed_url: string };

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .send({
        success: true,
        signedUrl: data.signed_url,
        systemPrompt,
        voiceId,
        firstMessage: (bot.welcomeMessage ?? "Hello! How can I help you today?")
          .replace(/[\u{1F300}-\u{1FFFF}]/gu, "")  // strip emojis
          .trim() || "Hello! How can I help you today?",
        language: bot.language?.toLowerCase().startsWith("english") ? "en" : "en",
        botName: bot.name,
        logoUrl: bot.logoUrl,
        brandColor: bot.brandColor,
      });
  });

  // ── POST /api/widget/voice/session/:botId ─────────────────────────────────
  // Creates an OpenAI Realtime API session + ephemeral key for WebRTC.
  // The widget uses this to connect directly to OpenAI Realtime (~200ms latency).
  app.post("/api/widget/voice/session/:botId", async (request, reply) => {
    const { botId } = request.params as { botId: string };

    if (!env.OPENAI_API_KEY) {
      return reply.status(503).send(fail("OpenAI API key not configured"));
    }

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    if (bot.status !== "Live") return reply.status(403).send(fail("Bot is not live"));

    const ttsVoice = VOICE_MAP[bot.voice ?? "Nova (Warm female)"] ?? "nova";
    const { buildSystemPrompt } = await import("@/modules/chat/chat.routes");
    const systemPrompt = buildSystemPrompt(bot);

    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    let session: { id: string; client_secret: { value: string; expires_at: number } };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session = await (client.beta as any).realtime.sessions.create({
        model: "gpt-4o-realtime-preview",
        voice: ttsVoice,
        instructions: systemPrompt,
        modalities: ["text", "audio"],
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
        },
        input_audio_transcription: { model: "whisper-1" },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[OpenAI Realtime] session creation failed:", detail);
      return reply.status(502).send({ success: false, message: "Failed to create voice session", detail });
    }

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .send({
        success: true,
        ephemeralKey: session.client_secret.value,
        botName: bot.name,
        botVoice: bot.voice ?? "Nova (Warm female)",
        logoUrl: bot.logoUrl,
        brandColor: bot.brandColor,
      });
  });

  // ── POST /api/widget/voice/room/:botId ────────────────────────────────────
  // Creates a Daily.co room and returns room URL + meeting token (public).
  app.post("/api/widget/voice/room/:botId", async (request, reply) => {
    const { botId } = request.params as { botId: string };

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    if (!bot) return reply.status(404).send(fail("Bot not found"));
    if (bot.status !== "Live") return reply.status(403).send(fail("Bot is not live"));

    if (!env.DAILY_API_KEY) {
      // Return a dummy response so the widget can still do audio-only calling
      // (without a real Daily.co room). The widget uses browser MediaRecorder directly.
      return reply
        .header("Access-Control-Allow-Origin", "*")
        .send({
          success: true,
          roomUrl: null,
          token: null,
          botName: bot.name,
          botVoice: bot.voice ?? "Nova (Warm female)",
          botVoiceSpeed: bot.voiceSpeed ? Number(bot.voiceSpeed) : 50,
          logoUrl: bot.logoUrl,
          brandColor: bot.brandColor,
        });
    }

    // Create a fresh Daily.co room (audio-only, expires in 1 hour)
    let roomUrl: string | null = null;
    let token: string | null = null;

    try {
      const roomRes = await fetch("https://api.daily.co/v1/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.DAILY_API_KEY}`,
        },
        body: JSON.stringify({
          properties: {
            exp: Math.floor(Date.now() / 1000) + 3600,
            enable_chat: false,
            enable_screenshare: false,
            start_video_off: true,
            start_audio_off: false,
          },
        }),
      });

      if (!roomRes.ok) {
        const err = await roomRes.text();
        console.error("[Daily.co] room creation failed:", roomRes.status, err);
      } else {
        const room = (await roomRes.json()) as { url: string; name: string };
        roomUrl = room.url;

        // Create a participant token
        const tokenRes = await fetch("https://api.daily.co/v1/meeting-tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.DAILY_API_KEY}`,
          },
          body: JSON.stringify({
            properties: {
              room_name: room.name,
              exp: Math.floor(Date.now() / 1000) + 3600,
              is_owner: false,
            },
          }),
        });

        const tokenData = (await tokenRes.json()) as { token: string };
        token = tokenData.token ?? null;
      }
    } catch (err) {
      console.error("[Daily.co] network error:", err);
    }

    // Return success even if Daily.co fails — widget uses browser MediaRecorder directly
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .send({
        success: true,
        roomUrl,
        token,
        botName: bot.name,
        botVoice: bot.voice ?? "Nova (Warm female)",
        botVoiceSpeed: bot.voiceSpeed ? Number(bot.voiceSpeed) : 50,
        logoUrl: bot.logoUrl,
        brandColor: bot.brandColor,
      });
  });

  // ── POST /api/widget/voice/stt ────────────────────────────────────────────
  // Receives a multipart audio blob, returns transcribed text via Whisper.
  app.post("/api/widget/voice/stt", async (request, reply) => {
    if (!env.OPENAI_API_KEY) {
      return reply.status(503).send(fail("OpenAI API key not configured"));
    }

    const data = await request.file();
    if (!data) return reply.status(400).send(fail("No audio file provided"));

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length < 100) {
      return reply
        .header("Access-Control-Allow-Origin", "*")
        .send({ success: true, text: "" });
    }

    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    const transcription = await client.audio.transcriptions.create({
      file: new File([buffer], "audio.webm", { type: "audio/webm" }),
      model: "whisper-1",
      response_format: "json",
      // Prompt guides Whisper toward English/Urdu and prevents Chinese hallucination
      prompt: "This is a conversation in English or Roman Urdu (Urdu written in Latin script).",
    });

    const text = transcription.text?.trim() ?? "";

    // Reject Whisper hallucinations — CJK characters mean it misread silence as Chinese
    const hasCJK = /[一-鿿぀-ヿ가-힯]/.test(text);

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .send({ success: true, text: hasCJK ? "" : text });
  });

  // ── POST /api/widget/voice/tts ────────────────────────────────────────────
  // Converts text to speech using OpenAI TTS and streams back MP3 audio.
  app.post("/api/widget/voice/tts", async (request, reply) => {
    if (!env.OPENAI_API_KEY) {
      return reply.status(503).send(fail("OpenAI API key not configured"));
    }

    const schema = z.object({
      text: z.string().min(1).max(4096),
      voice: z.string().default("Nova (Warm female)"),
      speed: z.number().min(0).max(100).default(50),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(fail("Invalid request", parsed.error.flatten().fieldErrors));
    }

    const { text, voice, speed } = parsed.data;
    const ttsVoice = VOICE_MAP[voice] ?? "nova";
    const ttsSpeed = mapSpeed(speed);

    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    const audio = await client.audio.speech.create({
      model: "tts-1",
      voice: ttsVoice,
      input: text,
      speed: ttsSpeed,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await audio.arrayBuffer());

    return reply
      .header("Content-Type", "audio/mpeg")
      .header("Content-Length", buffer.length)
      .header("Access-Control-Allow-Origin", "*")
      .send(buffer);
  });
}
