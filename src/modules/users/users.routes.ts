import type { FastifyInstance } from "fastify";
import { authenticate } from "@/middleware/authenticate";
import { ok, fail } from "@/utils/response";
import { UsersService } from "./users.service";
import { updateProfileSchema } from "./users.schema";

export async function usersRoutes(app: FastifyInstance) {
  // GET /api/users/me
  app.get(
    "/api/users/me",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = await UsersService.findById(request.user.id);
      if (!user) return reply.status(404).send(fail("User not found"));
      return reply.send(ok(user));
    }
  );

  // PATCH /api/users/me
  app.patch(
    "/api/users/me",
    { preHandler: authenticate },
    async (request, reply) => {
      const parsed = updateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send(
          fail("Validation failed", parsed.error.flatten().fieldErrors as Record<string, string[]>)
        );
      }
      const updated = await UsersService.update(request.user.id, parsed.data);
      if (!updated) return reply.status(404).send(fail("User not found"));
      return reply.send(ok(updated, "Profile updated successfully"));
    }
  );
}
