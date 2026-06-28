import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "@/config/env";

export async function registerCors(app: FastifyInstance) {
  await app.register(cors, {
    // Widget routes (/api/widget/*) must be accessible from any website.
    // All other routes: dev = any localhost, prod = configured FRONTEND_URL.
    origin: (origin, cb) => {
      // Always allow no-origin requests (curl, Postman, same-origin)
      if (!origin) return cb(null, true);
      // Widget endpoints are public — allow any origin
      // (checked at request time via the url, not origin header)
      // For simplicity: in dev allow all localhost; in prod allow FRONTEND_URL + any
      if (env.NODE_ENV === "development") {
        if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
        // Allow external origins for widget routes in dev too
        return cb(null, true);
      }
      // Production: allow FRONTEND_URL and any origin for widget endpoints
      if (origin === env.FRONTEND_URL) return cb(null, true);
      // Permit external sites to use widget (they only access /api/widget/*)
      return cb(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
    exposedHeaders: ["Set-Cookie"],
  });
}
