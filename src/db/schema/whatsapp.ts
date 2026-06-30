import { pgTable, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { bots } from "./bots";

export const waStatusEnum = pgEnum("wa_session_status", [
  "PENDING",
  "QR_READY",
  "CONNECTED",
  "DISCONNECTED",
  "EXPIRED",
]);

export const whatsappSessions = pgTable("whatsapp_session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  botId: text("bot_id").references(() => bots.id, { onDelete: "set null" }),
  sessionId: text("session_id").notNull().unique(),
  phoneNumber: text("phone_number").notNull().default(""),
  displayName: text("display_name").notNull().default(""),
  profilePicture: text("profile_picture").notNull().default(""),
  status: waStatusEnum("status").notNull().default("PENDING"),
  qrCode: text("qr_code").notNull().default(""),
  connectedAt: timestamp("connected_at"),
  lastSeen: timestamp("last_seen"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type WhatsAppSession = typeof whatsappSessions.$inferSelect;
export type NewWhatsAppSession = typeof whatsappSessions.$inferInsert;
