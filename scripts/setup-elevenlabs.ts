/**
 * ElevenLabs Setup Script
 * Usage: npx tsx scripts/setup-elevenlabs.ts <YOUR_ELEVENLABS_API_KEY>
 *
 * This script will:
 * 1. Verify your ElevenLabs API key works
 * 2. Create a Conversational AI agent with optimal settings for HelixAI
 * 3. Print the Agent ID + update your .env file automatically
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const API_KEY = process.argv[2];

if (!API_KEY || API_KEY === "YOUR_KEY_HERE") {
  console.error(`
❌  Usage: npx tsx scripts/setup-elevenlabs.ts <YOUR_ELEVENLABS_API_KEY>

Steps to get your API key:
  1. Sign up at https://elevenlabs.io  (free plan available)
  2. Go to: Profile → API Keys → Create API Key
  3. Copy the key and run this script again
`);
  process.exit(1);
}

const BASE = "https://api.elevenlabs.io";

async function el<T>(path: string, opts: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const data = (await res.json()) as T;
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  console.log("\n🔑  Verifying API key…");
  const me = await el<{ first_name?: string; subscription?: { tier: string } }>("/v1/user");
  if (!me.ok) {
    console.error("❌  Invalid API key — please check and try again");
    process.exit(1);
  }
  console.log(`✅  Connected as ${me.data.first_name ?? "user"} (${me.data.subscription?.tier ?? "unknown"} plan)`);

  console.log("\n🤖  Creating Conversational AI agent…");

  const agentBody = {
    name: "HelixAI Voice Agent",
    conversation_config: {
      agent: {
        prompt: {
          prompt: "You are a helpful AI voice assistant. Be concise, natural, and warm. Respond as if on a phone call.",
          llm: "gpt-4o-mini",
          temperature: 0.7,
          max_tokens: 300,
        },
        first_message: "Hello! How can I help you today?",
        language: "en",
      },
      tts: {
        model_id: "eleven_turbo_v2_5",
        voice_id: "21m00Tcm4TlvDq8ikWAM", // Rachel (warm female)
        stability: 0.5,
        similarity_boost: 0.75,
        optimize_streaming_latency: 4,
      },
      asr: {
        quality: "high",
        provider: "elevenlabs",
        user_input_audio_format: "pcm_16000",
        keywords: [],
      },
      turn: {
        turn_timeout: 7,
        mode: "turn",
      },
    },
    platform_settings: {
      widget: {
        expandable: "always",
      },
    },
  };

  const agentRes = await el<{ agent_id?: string; detail?: string }>("/v1/convai/agents/create", {
    method: "POST",
    body: JSON.stringify(agentBody),
  });

  if (!agentRes.ok || !agentRes.data.agent_id) {
    console.error("❌  Failed to create agent:", agentRes.data.detail ?? agentRes.status);
    process.exit(1);
  }

  const agentId = agentRes.data.agent_id;
  console.log(`✅  Agent created: ${agentId}`);

  // Update .env file
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    console.error("❌  .env file not found — run this from the backend/ directory");
    process.exit(1);
  }

  let envContent = readFileSync(envPath, "utf-8");
  envContent = envContent
    .replace(/^ELEVENLABS_API_KEY=.*$/m, `ELEVENLABS_API_KEY=${API_KEY}`)
    .replace(/^ELEVENLABS_AGENT_ID=.*$/m, `ELEVENLABS_AGENT_ID=${agentId}`);
  writeFileSync(envPath, envContent, "utf-8");

  console.log(`\n✅  .env updated with your keys`);

  // Update Claude MCP settings
  const settingsPath = resolve(
    process.env.USERPROFILE ?? process.env.HOME ?? "~",
    ".claude", "settings.json"
  );
  if (existsSync(settingsPath)) {
    let settings = readFileSync(settingsPath, "utf-8");
    settings = settings.replace("FILL_IN_YOUR_KEY", API_KEY);
    writeFileSync(settingsPath, settings, "utf-8");
    console.log("✅  Claude MCP settings updated with ElevenLabs API key");
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  ElevenLabs setup complete!

  API Key:  ${API_KEY.slice(0, 8)}…
  Agent ID: ${agentId}

Restart your backend server to apply the changes:
  cd backend && npm run dev
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

main().catch((err) => {
  console.error("Setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
