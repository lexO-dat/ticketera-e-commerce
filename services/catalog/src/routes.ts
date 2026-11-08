import { AppError, ZERO_CLP } from "@shared/commons";
import type { AuthGuards } from "@shared/commons/auth";
import type { Pool } from "@shared/commons/db";
import { parseInput } from "@shared/commons/http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  EVENT_CATEGORIES,
  EVENT_STATUSES,
  type EventDateInput,
  type EventService,
} from "./events/service.js";
import type { SellableItemCatalog } from "./items/registry.js";
import type { MediaService } from "./media/service.js";
import type { MetricsService } from "./metrics/service.js";
import { PRODUCT_STATUSES, type ProductService } from "./products/service.js";
import { type Actor, clpInput } from "./shared.js";
import type { VenueService } from "./venues/service.js";

export interface RouteDependencies {
  pool: Pool;
  events: EventService;
  venues: VenueService;
  products: ProductService;
  media: MediaService;
  items: SellableItemCatalog;
  metrics: MetricsService;
  guards: AuthGuards;
  /** Segundos de caché HTTP en lecturas públicas (navegador / Nginx). */
  publicMaxAgeSeconds: number;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));
// `guid`: acepta los UUID no-RFC del seed del prototipo (p. ej. e0000000-0000-…).
const id = z.object({ id: z.guid() });
const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const schemas = {
  listEvents: z.object({
    category: z.enum(EVENT_CATEGORIES).optional(),
    city: z.string().trim().max(80).optional(),
    q: z.string().trim().max(100).optional(),
    sort: z.enum(["date", "popular", "price"]).optional(),
    featured: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  }),
  slug: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }),
  newsletter: z.strictObject({ email: z.email().max(254) }),
  metrics: z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }),
  listProducts: z.object({ eventId: z.guid().optional() }),
  resolveItems: z.strictObject({
    items: z
      .array(z.strictObject({ kind: z.string().regex(/^[a-z_]{1,40}$/), id: z.guid() }))
      .min(1)
      .max(50),
  }),
  event: z.strictObject({
    title: text(140),
    artist: optionalText(140),
    category: z.enum(EVENT_CATEGORIES),
    description: optionalText(4000),
    imageId: z
      .guid()
      .nullish()
      .transform((value) => value ?? null),
    status: z.enum(EVENT_STATUSES),
    featured: z.boolean(),
    urgencyNote: optionalText(140),
    ageRestriction: optionalText(60),
  }),
  date: z
    .strictObject({
      venueId: z.guid(),
      startsAt: isoDate,
      doorsAt: isoDate.nullish().transform((value) => value ?? null),
      onSale: z.boolean(),
      ticketTypes: z
        .array(
          z.strictObject({
            sectionId: z.guid(),
            name: text(80),
            price: clpInput,
            fee: clpInput,
            capacity: z.int().min(0).max(1_000_000),
          }),
        )
        .max(50),
    })
    .refine((date) => !date.doorsAt || date.doorsAt <= date.startsAt, {
      path: ["doorsAt"],
      message: "La apertura de puertas debe ser antes del inicio",
    }),
  venue: z.strictObject({
    name: text(120),
    city: text(80),
    address: optionalText(200),
    capacity: z.int().min(0).max(1_000_000),
    mapWidth: z.int().min(100).max(5000).optional(),
    mapHeight: z.int().min(100).max(5000).optional(),
  }),
  section: z.strictObject({
    name: text(80),
    kind: z.enum(["seated", "general"]),
    capacity: z.int().min(0).max(1_000_000),
    sortOrder: z.int().min(0).max(99),
    shape: z.strictObject({
      x: z.number().min(0).max(5000),
      y: z.number().min(0).max(5000),
      w: z.number().min(10).max(5000),
      h: z.number().min(10).max(5000),
    }),
    seatGrid: z
      .strictObject({ rows: z.int().min(1).max(60), perRow: z.int().min(1).max(80) })
      .optional(),
  }),
  seat: z.strictObject({ blocked: z.boolean() }),
  queue: z.strictObject({
    enabled: z.boolean(),
    opensAt: isoDate.nullish().transform((value) => value ?? null),
    concurrentSlots: z.int().min(1).max(10_000),
    windowMinutes: z.int().min(1).max(120),
    admitBatchMax: z.int().min(1).max(1_000).default(50),
    waitingMessage: optionalText(300),
  }),
  product: z.strictObject({
    name: text(140),
    description: optionalText(4000),
    sku: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,40}$/)
      .nullish()
      .transform((value) => value ?? null),
    price: clpInput,
    fee: clpInput.optional().transform((value) => value ?? ZERO_CLP),
    imageId: z
      .guid()
      .nullish()
      .transform((value) => value ?? null),
    eventId: z
      .guid()
      .nullish()
      .transform((value) => value ?? null),
    status: z.enum(PRODUCT_STATUSES),
    maxPerOrder: z.int().min(1).max(100).default(10),
  }),
};

function actor(request: FastifyRequest): Actor {
  if (!request.user) throw AppError.unauthenticated();
  return request.user;
}

function publicCache(reply: FastifyReply, seconds: number) {
  // stale-while-revalidate: Nginx / el navegador sirven la copia mientras se refresca.
  reply.header(
    "cache-control",
    `public, max-age=${seconds}, stale-while-revalidate=${seconds * 2}`,
  );
}

export function registerRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { events, venues, products, media, items, guards, pool } = deps;
  const maxAge = deps.publicMaxAgeSeconds;

  // ---------- Lectura pública (cacheada en Redis y en HTTP) ----------

  app.get("/v1/events", async (request, reply) => {
    const query = parseInput(schemas.listEvents, request.query);
    publicCache(reply, maxAge);
    return events.listPublic(query);
  });

  app.get("/v1/events/:slug", async (request, reply) => {
    const { slug } = parseInput(schemas.slug, request.params);
    publicCache(reply, maxAge);
    return events.getPublic(slug);
  });

  app.get("/v1/events/by-id/:id", async (request, reply) => {
    const params = parseInput(id, request.params);
    publicCache(reply, maxAge);
    return events.getPublicById(params.id);
  });

  app.get("/v1/dates/:id/seat-map", async (request, reply) => {
    const params = parseInput(id, request.params);
    publicCache(reply, maxAge);
    return events.seatMap(params.id);
  });

  app.get("/v1/venues", async (_request, reply) => {
    publicCache(reply, maxAge);
    return { items: await venues.list() };
  });

  app.get("/v1/products", async (request, reply) => {
    const query = parseInput(schemas.listProducts, request.query);
    publicCache(reply, maxAge);
    return { items: await products.listPublic(query) };
  });

  app.get("/v1/products/:slug", async (request, reply) => {
    const { slug } = parseInput(schemas.slug, request.params);
    publicCache(reply, maxAge);
    return products.getPublic(slug);
  });

  app.get("/v1/media/:id", async (request, reply) => {
    const params = parseInput(id, request.params);
    const file = await media.get(params.id);
    if (!file) throw AppError.notFound("La imagen no existe");
    const etag = `"${file.sha256}"`;
    reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("etag", etag)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox");
    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.type(file.contentType).send(file.data);
  });

  /** `ItemVendible`: precio y estado de venta de cualquier tipo de ítem (lo usa `orders`). */
  app.post("/v1/items/resolve", async (request, reply) => {
    const body = parseInput(schemas.resolveItems, request.body);
    reply.header("cache-control", "no-store");
    return { items: await items.resolve(pool, body.items), kinds: items.kinds() };
  });

  // ---------- Administración (gateway: admin / organizer / seller; aquí: rol + dueño) ----------

  const staff = { preHandler: guards.required("admin", "organizer", "seller") };
  const organizers = { preHandler: guards.required("admin", "organizer") };
  const sellers = { preHandler: guards.required("admin", "seller") };
  const admins = { preHandler: guards.required("admin") };

  // Métricas del embudo y newsletter (antes en Supabase). Públicos y con rate limit en el gateway.
  app.post("/v1/events/:id/views", async (request, reply) => {
    const params = parseInput(id, request.params);
    await deps.metrics.recordView(params.id);
    return reply.status(202).send();
  });

  app.post("/v1/newsletter", async (request, reply) => {
    const body = parseInput(schemas.newsletter, request.body);
    await deps.metrics.subscribe(body.email);
    // Misma respuesta si ya estaba suscrito: no revela qué correos existen.
    return reply.status(202).send();
  });

  app.get("/v1/admin/metrics", organizers, async (request) => {
    const query = parseInput(schemas.metrics, request.query);
    return deps.metrics.summary(actor(request), query.days);
  });

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/v1/admin/")) reply.header("cache-control", "no-store");
  });

  app.post("/v1/admin/media", staff, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      throw AppError.validation([{ path: "file", message: "Adjunta una imagen" }]);
    }
    const buffer = await file.toBuffer();
    const stored = await media.upload(actor(request), buffer);
    return reply.status(201).send(stored);
  });

  app.get("/v1/admin/events", organizers, async (request) => ({
    items: await events.listForAdmin(actor(request)),
  }));

  app.get("/v1/admin/events/:id", organizers, async (request) => {
    const params = parseInput(id, request.params);
    return events.getForAdmin(actor(request), params.id);
  });

  app.post("/v1/admin/events", organizers, async (request, reply) => {
    const body = parseInput(schemas.event, request.body);
    return reply.status(201).send(await events.create(actor(request), body, request.id));
  });

  app.put("/v1/admin/events/:id", organizers, async (request) => {
    const params = parseInput(id, request.params);
    const body = parseInput(schemas.event, request.body);
    return events.update(actor(request), params.id, body, request.id);
  });

  app.delete("/v1/admin/events/:id", organizers, async (request, reply) => {
    const params = parseInput(id, request.params);
    await events.remove(actor(request), params.id, request.id);
    return reply.status(204).send();
  });

  app.put("/v1/admin/events/:id/queue", organizers, async (request) => {
    const params = parseInput(id, request.params);
    const body = parseInput(schemas.queue, request.body);
    return events.updateQueue(actor(request), params.id, body, request.id);
  });

  app.post("/v1/admin/events/:id/dates", organizers, async (request, reply) => {
    const params = parseInput(id, request.params);
    const body: EventDateInput = parseInput(schemas.date, request.body);
    return reply
      .status(201)
      .send(await events.createDate(actor(request), params.id, body, request.id));
  });

  app.put("/v1/admin/dates/:id", organizers, async (request) => {
    const params = parseInput(id, request.params);
    const body: EventDateInput = parseInput(schemas.date, request.body);
    return events.updateDate(actor(request), params.id, body, request.id);
  });

  app.delete("/v1/admin/dates/:id", organizers, async (request) => {
    const params = parseInput(id, request.params);
    return events.removeDate(actor(request), params.id, request.id);
  });

  // Los organizadores ven los recintos para programar fechas; solo admin los modifica.
  app.get("/v1/admin/venues", organizers, async () => ({ items: await venues.list() }));

  app.post("/v1/admin/venues", admins, async (request, reply) => {
    const body = parseInput(schemas.venue, request.body);
    return reply.status(201).send(await venues.create(body));
  });

  app.put("/v1/admin/venues/:id", admins, async (request) => {
    const params = parseInput(id, request.params);
    const body = parseInput(schemas.venue, request.body);
    return venues.update(params.id, body);
  });

  app.delete("/v1/admin/venues/:id", admins, async (request, reply) => {
    const params = parseInput(id, request.params);
    await venues.remove(params.id);
    return reply.status(204).send();
  });

  app.post("/v1/admin/venues/:id/sections", admins, async (request, reply) => {
    const params = parseInput(id, request.params);
    const body = parseInput(schemas.section, request.body);
    return reply.status(201).send(await venues.createSection({ ...body, venueId: params.id }));
  });

  app.put("/v1/admin/sections/:id", admins, async (request) => {
    const params = parseInput(id, request.params);
    const body = parseInput(schemas.section, request.body);
    return venues.updateSection(params.id, body);
  });

  app.delete("/v1/admin/sections/:id", admins, async (request, reply) => {
    const params = parseInput(id, request.params);
    await venues.removeSection(params.id);
    return reply.status(204).send();
  });

  app.get("/v1/admin/sections/:id/seats", organizers, async (request) => {
    const params = parseInput(id, request.params);
    return { items: await venues.seats(params.id) };
  });

  app.put("/v1/admin/seats/:id", admins, async (request, reply) => {
    const params = parseInput(id, request.params);
    const body = parseInput(schemas.seat, request.body);
    await venues.setSeatBlocked(params.id, body.blocked);
    return reply.status(204).send();
  });

  app.get("/v1/admin/products", sellers, async (request) => ({
    items: await products.listForAdmin(actor(request)),
  }));

  app.post("/v1/admin/products", sellers, async (request, reply) => {
    const body = parseInput(schemas.product, request.body);
    return reply.status(201).send(await products.create(actor(request), body, request.id));
  });

  app.put("/v1/admin/products/:id", sellers, async (request) => {
    const params = parseInput(id, request.params);
    const body = parseInput(schemas.product, request.body);
    return products.update(actor(request), params.id, body, request.id);
  });

  app.delete("/v1/admin/products/:id", sellers, async (request, reply) => {
    const params = parseInput(id, request.params);
    await products.remove(actor(request), params.id, request.id);
    return reply.status(204).send();
  });
}
