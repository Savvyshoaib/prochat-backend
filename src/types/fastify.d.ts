import type { AuthUser, Session } from "@/lib/auth";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
    session: Session["session"];
  }
}
