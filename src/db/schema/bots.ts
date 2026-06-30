import {
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const botStatusEnum = pgEnum("bot_status", ["Draft", "Live", "Paused"]);

export const bots = pgTable("bot", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull().default(""),
  description: text("description").notNull().default(""),
  language: text("language").notNull().default("English (US)"),
  tone: text("tone").notNull().default("Professional"),
  persona: text("persona").notNull().default(""),
  instructions: text("instructions").notNull().default(
    "You are a helpful customer support assistant. Always be polite, concise, and accurate. If you don't know the answer, escalate to a human agent."
  ),
  welcomeMessage: text("welcome_message")
    .notNull()
    .default("Hi 👋 How can I help you today?"),
  brandColor: text("brand_color").notNull().default("#4f46e5"),
  logoUrl: text("logo_url").notNull().default(""),
  chatBubbleIcon: text("chat_bubble_icon").notNull().default("message"),
  bubbleIconUrl: text("bubble_icon_url").notNull().default(""),
  chatPosition: text("chat_position").notNull().default("bottom-right"),
  footerText: text("footer_text").notNull().default("Powered by HelixAI"),
  voice: text("voice").notNull().default("Nova (Warm female)"),
  voiceSpeed: numeric("voice_speed", { precision: 4, scale: 1 })
    .notNull()
    .default("50"),
  knowledgeText: text("knowledge_text").notNull().default(""),
  websiteUrl: text("website_url").notNull().default(""),
  crawlDepth: text("crawl_depth")
    .notNull()
    .default("3 levels (recommended)"),
  // WhatsApp integration
  waPhoneNumberId: text("wa_phone_number_id").notNull().default(""),
  waAccessToken: text("wa_access_token").notNull().default(""),
  status: botStatusEnum("status").notNull().default("Draft"),
  step: integer("step").notNull().default(1),
  deployments: jsonb("deployments")
    .$type<string[]>()
    .notNull()
    .default(["Website widget"]),
  knowledgeFiles: jsonb("knowledge_files")
    .$type<{ name: string; size: string; type?: "file" | "website"; url?: string }[]>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Bot = typeof bots.$inferSelect;
export type NewBot = typeof bots.$inferInsert;
