import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:4000"),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),

  // ── AI Provider selection ──────────────────────────────────────────────────
  // Set AI_PROVIDER in .env to switch between providers — no code changes needed
  // Options: openai | anthropic | openrouter
  AI_PROVIDER: z.enum(["openai", "anthropic", "openrouter"]).default("openrouter"),

  // Optional: override the default model for the chosen provider
  // openai default:      gpt-4o-mini
  // anthropic default:   claude-sonnet-4-6
  // openrouter default:  openai/gpt-4o-mini
  AI_MODEL: z.string().optional(),

  // ── API Keys (only the one matching AI_PROVIDER is required) ──────────────
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),

  // ── Gemini (for AI content generation — free tier) ────────────────────────
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-1.5-flash"),

  // ── Email (optional) ──────────────────────────────────────────────────────
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

// Validate that the required key for the chosen provider is present
const providerKeyMap: Record<string, string | undefined> = {
  openai: env.OPENAI_API_KEY,
  anthropic: env.ANTHROPIC_API_KEY,
  openrouter: env.OPENROUTER_API_KEY,
};

if (!providerKeyMap[env.AI_PROVIDER]) {
  console.error(
    `\n❌  AI_PROVIDER is set to "${env.AI_PROVIDER}" but ${env.AI_PROVIDER.toUpperCase()}_API_KEY is missing in .env\n`
  );
  process.exit(1);
}

console.log(`✅  AI Provider: ${env.AI_PROVIDER} | Model: ${env.AI_MODEL ?? "default"} | Gemini: ${env.GEMINI_MODEL}`);
