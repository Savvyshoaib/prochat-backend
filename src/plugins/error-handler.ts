import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { fail } from "@/utils/response";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);

    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      error.errors.forEach((e) => {
        const key = e.path.join(".") || "root";
        fieldErrors[key] = [...(fieldErrors[key] ?? []), e.message];
      });
      return reply.status(422).send(fail("Validation failed", fieldErrors));
    }

    if (error.statusCode === 429) {
      return reply.status(429).send(fail("Too many requests. Please slow down."));
    }

    const statusCode = error.statusCode ?? 500;
    const message =
      statusCode < 500
        ? error.message
        : "An unexpected error occurred. Please try again.";

    return reply.status(statusCode).send(fail(message));
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(fail("Route not found"));
  });
}
