import type { FastifyInstance } from "fastify";
import { auth } from "@/lib/auth";
import { env } from "@/config/env";

// Headers that @fastify/cors already manages — don't let Better Auth override them.
const CORS_HEADERS = new Set([
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
]);

export async function authRoutes(app: FastifyInstance) {
  // Proxy all /api/auth/* requests to Better Auth handler.
  // Fastify wildcard captures /api/auth/sign-in/email, /api/auth/get-session, etc.
  app.all("/api/auth/*", async (request, reply) => {
    // Build the full URL using the Host header (most reliable across dev/proxy)
    const host = request.headers.host ?? `localhost:${env.PORT}`;
    const protocol =
      (request.headers["x-forwarded-proto"] as string | undefined) ??
      request.protocol ??
      "http";
    const url = new URL(request.url, `${protocol}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          value.forEach((v) => headers.append(key, v));
        } else {
          headers.set(key, value);
        }
      }
    }

    const body =
      request.method !== "GET" && request.method !== "HEAD"
        ? JSON.stringify(request.body)
        : undefined;

    const webRequest = new Request(url.toString(), {
      method: request.method,
      headers,
      body,
    });

    const response = await auth.handler(webRequest);

    reply.status(response.status);

    // Forward all headers from Better Auth EXCEPT CORS headers —
    // those are already set by @fastify/cors and must not be overridden.
    response.headers.forEach((value, key) => {
      if (!CORS_HEADERS.has(key.toLowerCase())) {
        reply.header(key, value);
      }
    });

    const responseBody = await response.text();
    if (responseBody) {
      reply.send(responseBody);
    } else {
      reply.send();
    }
  });
}
