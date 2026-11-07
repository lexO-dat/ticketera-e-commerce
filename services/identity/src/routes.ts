import { AppError } from "@shared/commons";
import { type AuthGuards, Roles } from "@shared/commons/auth";
import { parseInput } from "@shared/commons/http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdminService } from "./admin/service.js";
import type { AuthService } from "./auth/service.js";
import type { KeyStore } from "./crypto/keys.js";
import { PASSWORD_MAX_LENGTH } from "./crypto/passwords.js";

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
// La política completa (largo mínimo, comunes) se valida en el servicio; aquí solo el tope (DoS).
const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const fullName = z.string().trim().min(1).max(120);
const role = z.enum(Roles);

const schemas = {
  register: z.strictObject({ email, password, fullName }),
  login: z.strictObject({ email, password }),
  refresh: z.strictObject({ refreshToken: z.string().min(1).max(200) }),
  profile: z.strictObject({ fullName }),
  token: z.strictObject({ token: z.string().min(1).max(200) }),
  forgot: z.strictObject({ email }),
  reset: z.strictObject({ token: z.string().min(1).max(200), newPassword: password }),
  change: z.strictObject({ currentPassword: password, newPassword: password }),
  listUsers: z.object({
    q: z.string().trim().max(100).optional(),
    role: role.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  }),
  createUser: z.strictObject({
    email,
    fullName,
    password,
    roles: z.array(role).min(1).max(Roles.length),
  }),
  userId: z.object({ id: z.uuid() }),
  roles: z.strictObject({ roles: z.array(role).max(Roles.length) }),
};

function sessionContext(request: FastifyRequest) {
  const userAgent = request.headers["user-agent"];
  return { userAgent: typeof userAgent === "string" ? userAgent : undefined, ip: request.ip };
}

function currentUser(request: FastifyRequest) {
  if (!request.user) throw AppError.unauthenticated();
  return request.user;
}

export function registerRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; admin: AdminService; keys: KeyStore; guards: AuthGuards },
): void {
  const { auth, admin, keys, guards } = deps;

  // Respuestas con tokens o datos personales: nunca en cachés intermedias.
  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/v1/")) reply.header("cache-control", "no-store");
  });

  app.get("/.well-known/jwks.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return keys.jwks();
  });

  app.post("/v1/auth/register", async (request, reply) => {
    const body = parseInput(schemas.register, request.body);
    await auth.register(body, request.id);
    return reply.status(202).send({
      status: "accepted",
      message: "Si el email no estaba registrado, te enviamos un enlace para verificarlo.",
    });
  });

  app.post("/v1/auth/login", async (request) => {
    const body = parseInput(schemas.login, request.body);
    return auth.login(body, sessionContext(request));
  });

  app.post("/v1/auth/refresh", async (request) => {
    const body = parseInput(schemas.refresh, request.body);
    return auth.refresh(body.refreshToken, sessionContext(request));
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const body = parseInput(schemas.refresh, request.body);
    await auth.logout(body.refreshToken);
    return reply.status(204).send();
  });

  app.post("/v1/auth/logout-all", { preHandler: guards.required() }, async (request, reply) => {
    await auth.logoutAll(currentUser(request).id);
    return reply.status(204).send();
  });

  app.get("/v1/auth/me", { preHandler: guards.required() }, async (request) => {
    return auth.me(currentUser(request).id);
  });

  app.patch("/v1/auth/me", { preHandler: guards.required() }, async (request) => {
    const body = parseInput(schemas.profile, request.body);
    return auth.updateProfile(currentUser(request).id, body.fullName);
  });

  app.post("/v1/auth/email/verify", async (request, reply) => {
    const body = parseInput(schemas.token, request.body);
    await auth.verifyEmail(body.token);
    return reply.status(204).send();
  });

  app.post("/v1/auth/email/resend", { preHandler: guards.required() }, async (request, reply) => {
    await auth.resendVerification(currentUser(request).id, request.id);
    return reply.status(202).send({ status: "accepted" });
  });

  app.post("/v1/auth/password/forgot", async (request, reply) => {
    const body = parseInput(schemas.forgot, request.body);
    await auth.forgotPassword(body.email, request.id);
    return reply.status(202).send({
      status: "accepted",
      message:
        "Si existe una cuenta con ese email, te enviamos un enlace para restablecer la contraseña.",
    });
  });

  app.post("/v1/auth/password/reset", async (request, reply) => {
    const body = parseInput(schemas.reset, request.body);
    await auth.resetPassword(body.token, body.newPassword);
    return reply.status(204).send();
  });

  app.post(
    "/v1/auth/password/change",
    { preHandler: guards.required() },
    async (request, reply) => {
      const body = parseInput(schemas.change, request.body);
      const user = currentUser(request);
      await auth.changePassword(user.id, user.sessionId, body.currentPassword, body.newPassword);
      return reply.status(204).send();
    },
  );

  // --- Administración de usuarios (reemplaza auth.admin.* de Supabase) ---
  const adminOnly = { preHandler: guards.required("admin") };

  app.get("/v1/admin/users", adminOnly, async (request) => {
    const query = parseInput(schemas.listUsers, request.query);
    return admin.list({
      query: query.q,
      role: query.role,
      limit: query.limit,
      cursor: query.cursor,
    });
  });

  app.post("/v1/admin/users", adminOnly, async (request, reply) => {
    const body = parseInput(schemas.createUser, request.body);
    return reply.status(201).send(await admin.create(body, request.id));
  });

  app.get("/v1/admin/users/:id", adminOnly, async (request) => {
    const { id } = parseInput(schemas.userId, request.params);
    return admin.get(id);
  });

  app.put("/v1/admin/users/:id/roles", adminOnly, async (request) => {
    const { id } = parseInput(schemas.userId, request.params);
    const body = parseInput(schemas.roles, request.body);
    return admin.setRoles(currentUser(request).id, id, body.roles);
  });

  app.post("/v1/admin/users/:id/disable", adminOnly, async (request) => {
    const { id } = parseInput(schemas.userId, request.params);
    return admin.setStatus(currentUser(request).id, id, "disabled");
  });

  app.post("/v1/admin/users/:id/enable", adminOnly, async (request) => {
    const { id } = parseInput(schemas.userId, request.params);
    return admin.setStatus(currentUser(request).id, id, "active");
  });
}
