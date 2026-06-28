import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "@/lib/auth";
import { fail } from "@/utils/response";

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const session = await auth.api.getSession({
      headers: new Headers(request.headers as Record<string, string>),
    });

    if (!session) {
      return reply.status(401).send(fail("Unauthorized. Please sign in."));
    }

    request.user = session.user;
    request.session = session.session;
  } catch {
    return reply.status(401).send(fail("Unauthorized. Invalid or expired session."));
  }
}
