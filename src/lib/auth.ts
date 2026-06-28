import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { env } from "@/config/env";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
    usePlural: false,
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // In development, accept all common Vite / TanStack Start ports.
  // In production, restrict to the configured FRONTEND_URL only.
  trustedOrigins:
    env.NODE_ENV === "development"
      ? [
          "http://localhost:3000",
          "http://localhost:5173",
          "http://localhost:4173",
          "http://localhost:8080", // Vite TanStack Start default
          "http://localhost:8081", // fallback if 8080 is taken
          env.FRONTEND_URL,
        ]
      : [env.FRONTEND_URL],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      // TODO: Integrate with SMTP/Resend for production
      console.log(`[Auth] Reset password link for ${user.email}: ${url}`);
    },
  },
  plugins: [bearer()],
  advanced: {
    disableCSRFCheck: true,
    // Ensure cookies are sent cross-origin (frontend:8080 → backend:4000).
    // SameSite=lax allows cross-port same-host cookies in dev.
    // In production set secure:true and use a real domain.
    cookiePrefix: "helix",
    cookies: {
      session_token: {
        attributes: {
          sameSite: "lax",
          secure: env.NODE_ENV === "production",
          httpOnly: true,
          path: "/",
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24,       // refresh once per day
  },
});

export type Session = typeof auth.$Infer.Session;
export type AuthUser = typeof auth.$Infer.Session.user;
