import { z } from "zod";

export const createBotSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(100).default(""),
  description: z.string().max(500).default(""),
  language: z.string().default("English (US)"),
  tone: z.string().default("Professional"),
  persona: z.string().default(""),
  instructions: z.string().default(""),
  welcomeMessage: z.string().default("Hi 👋 How can I help you today?"),
  brandColor: z.string().default("#4f46e5"),
  logoUrl: z.string().default(""),
  chatBubbleIcon: z.string().default("message"),
  bubbleIconUrl: z.string().default(""),
  chatPosition: z.string().default("bottom-right"),
  footerText: z.string().default("Powered by HelixAI"),
  voice: z.string().default("Nova (Warm female)"),
  voiceSpeed: z.number().min(0).max(100).default(50),
  knowledgeText: z.string().default(""),
  websiteUrl: z.string().default(""),
  crawlDepth: z.string().default("3 levels (recommended)"),
  status: z.enum(["Draft", "Live", "Paused"]).default("Draft"),
  step: z.number().int().min(1).max(9).default(1),
  deployments: z.array(z.string()).default(["Website widget"]),
  knowledgeFiles: z
    .array(z.object({ name: z.string(), size: z.string() }))
    .default([]),
  waPhoneNumberId: z.string().default(""),
  waAccessToken: z.string().default(""),
});

export const updateBotSchema = createBotSchema.partial();

export const updateBotStatusSchema = z.object({
  status: z.enum(["Draft", "Live", "Paused"]),
});

export type CreateBotInput = z.infer<typeof createBotSchema>;
export type UpdateBotInput = z.infer<typeof updateBotSchema>;
