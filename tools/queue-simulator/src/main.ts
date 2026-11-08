/**
 * Simulador de carga de la fila virtual y la reserva (docs/services/virtual-queue.md).
 *
 * Bots que inician sesión, entran a la fila, consultan respetando Retry-After, y al ser admitidos
 * compiten por butacas reales. Verifica: admitidos activos ≤ cupos, 0 sobreventa (auditoría de
 * inventory) y ninguna butaca entregada a dos bots. Sale con código ≠ 0 si algo falla (sirve en CI).
 *
 *   npm run simulate -w @tools/queue-simulator -- --event lumen-tour-santiago --bots 2000
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ApiClient, botIp, sleep } from "./client.js";
import { Counters, Latencies } from "./stats.js";

const { values: args } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:3000" },
    event: { type: "string", default: "lumen-tour-santiago" },
    date: { type: "string" },
    bots: { type: "string", default: "500" },
    ramp: { type: "string", default: "20" },
    "accept-ratio": { type: "string", default: "0.8" },
    "abandon-ratio": { type: "string", default: "0.05" },
    "hold-seconds": { type: "string", default: "3" },
    slots: { type: "string" },
    window: { type: "string" },
    "admin-email": { type: "string", default: "admin@ticketera.local" },
    "admin-password": { type: "string", default: "admin-dev-password-123" },
    "keep-orders": { type: "boolean", default: false },
    webpay: { type: "string", default: "http://127.0.0.1:3005" },
    "register-concurrency": { type: "string", default: "16" },
    "login-concurrency": { type: "string", default: "24" },
  },
});

const BOTS = Number(args.bots);
const RAMP_MS = Number(args.ramp) * 1000;
const ACCEPT_RATIO = Number(args["accept-ratio"]);
const ABANDON_RATIO = Number(args["abandon-ratio"]);
const HOLD_MS = Number(args["hold-seconds"]) * 1000;
const WEBPAY = args.webpay!;
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".data");
const USERS_FILE = join(DATA_DIR, "users.json");

const latency = {
  login: new Latencies(),
  join: new Latencies(),
  status: new Latencies(),
  reserve: new Latencies(),
  checkout: new Latencies(),
  /** Desde el retorno del adquirente hasta la orden confirmada o cancelada (saga asíncrona). */
  payment: new Latencies(),
  waitToAdmission: new Latencies(),
};
const counters = new Counters();
/** Butacas de cada bot cuya orden quedó confirmada (al final no puede haber repetidas). */
const confirmedSeats = new Map<number, string[]>();
const reservationsMade: { bot: number; id: string; client: ApiClient }[] = [];
const failures: string[] = [];

interface BotUser {
  email: string;
  password: string;
}

interface TicketType {
  id: string;
  name: string;
  sectionId: string;
  sectionKind: "seated" | "general";
  capacity: number;
}

function log(message: string) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

async function loadUsers(): Promise<BotUser[]> {
  try {
    return JSON.parse(await readFile(USERS_FILE, "utf8")) as BotUser[];
  } catch {
    return [];
  }
}

/** Crea (o reutiliza) las cuentas de los bots: `@acceptme.com` / `@rejectme.com` según la mezcla. */
async function ensureUsers(count: number): Promise<BotUser[]> {
  const users = await loadUsers();
  const missing = count - users.length;
  if (missing <= 0) return users.slice(0, count);
  log(`registrando ${missing} bots (se guardan en ${USERS_FILE} para la próxima corrida)…`);
  const created: BotUser[] = [];
  let next = users.length;
  const worker = async () => {
    while (next < count) {
      const index = next++;
      const domain = index % 100 < ACCEPT_RATIO * 100 ? "acceptme.com" : "rejectme.com";
      const user = {
        email: `bot-${index}-${randomBytes(3).toString("hex")}@${domain}`,
        password: randomBytes(18).toString("base64url"),
      };
      const client = new ApiClient(args.gateway!, botIp(index + 1));
      const response = await client.request("POST", "/auth/register", {
        body: { email: user.email, password: user.password, fullName: `Bot ${index}` },
      });
      if (response.status !== 202)
        throw new Error(`registro falló (${response.status}): ${JSON.stringify(response.body)}`);
      created[index - users.length] = user;
    }
  };
  await Promise.all(Array.from({ length: Number(args["register-concurrency"]) }, worker));
  const all = [...users, ...created];
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify(all, null, 1));
  return all.slice(0, count);
}

async function login(client: ApiClient, user: BotUser): Promise<boolean> {
  const response = await client.request<{ accessToken?: string }>("POST", "/auth/login", {
    body: { email: user.email, password: user.password },
  });
  latency.login.add(response.ms);
  if (response.status !== 200 || !response.body.accessToken) {
    counters.inc(`login_${response.status}`);
    return false;
  }
  client.accessToken = response.body.accessToken;
  return true;
}

function pickSeats(free: string[], count: number): string[] {
  const pool = [...free];
  const chosen: string[] = [];
  while (chosen.length < count && pool.length > 0) {
    chosen.push(pool.splice(randomInt(pool.length), 1)[0]!);
  }
  return chosen;
}

async function runBot(
  index: number,
  user: BotUser,
  ctx: {
    eventId: string;
    dateId: string;
    types: TicketType[];
    seatsBySection: Map<string, string[]>;
  },
  client: ApiClient,
) {
  const abandons = Math.random() < ABANDON_RATIO;

  const joined = await client.request<{ state: string }>(
    "POST",
    `/queue/events/${ctx.eventId}/join`,
  );
  latency.join.add(joined.ms);
  if (joined.status !== 200) {
    counters.inc(`join_${joined.status}`);
    return;
  }
  counters.inc("joined");
  const waitStarted = performance.now();

  // Sala de espera: consulta respetando Retry-After (con jitter), como el cliente web.
  let admission: string | undefined;
  let state = joined.body.state;
  let retryAfter = Number(joined.headers.get("retry-after") ?? 2);
  while (state !== "ADMITTED" && state !== "NOT_REQUIRED") {
    if (abandons) {
      counters.inc("abandoned_by_bot");
      return; // deja de consultar: el admisor debe descartarlo
    }
    if (["EXPIRED", "LEFT", "ABANDONED", "COMPLETED"].includes(state)) {
      counters.inc(`ended_${state}`);
      return;
    }
    await sleep(retryAfter * 1000 * (0.8 + Math.random() * 0.4));
    const status = await client.request<{ state: string; admissionToken: string | null }>(
      "GET",
      `/queue/events/${ctx.eventId}/status`,
    );
    latency.status.add(status.ms);
    if (status.status !== 200) {
      counters.inc(`status_${status.status}`);
      continue;
    }
    retryAfter = Number(status.headers.get("retry-after") ?? 2);
    state = status.body.state;
    admission = status.body.admissionToken ?? undefined;
  }
  latency.waitToAdmission.add(performance.now() - waitStarted);
  counters.inc(state === "ADMITTED" ? "admitted" : "no_queue");

  // Admitido: compite por entradas (hasta 3 intentos si alguien toma la butaca antes).
  const headers: Record<string, string> = admission ? { "x-admission-token": admission } : {};
  const wanted = 1 + randomInt(2);
  let reservationId: string | undefined;
  let reservedSeats: string[] = [];
  for (let attempt = 0; attempt < 3 && !reservationId; attempt++) {
    const type = ctx.types[randomInt(ctx.types.length)]!;
    let body: Record<string, unknown>;
    if (type.sectionKind === "seated") {
      const taken = await client.request<{ unavailableSeatIds: string[] }>(
        "GET",
        `/inventory/availability/dates/${ctx.dateId}/seats`,
      );
      const takenSet = new Set(taken.body.unavailableSeatIds ?? []);
      const free = (ctx.seatsBySection.get(type.id) ?? []).filter((seat) => !takenSet.has(seat));
      const seats = pickSeats(free, wanted);
      if (seats.length === 0) {
        counters.inc("no_free_seats");
        continue;
      }
      body = { ticketTypeId: type.id, seatIds: seats };
    } else {
      body = { ticketTypeId: type.id, quantity: wanted };
    }
    const reserved = await client.request<{ id: string; seatIds: string[]; reason?: string }>(
      "POST",
      "/inventory/reservations",
      { body, headers },
    );
    latency.reserve.add(reserved.ms);
    if (reserved.status === 201) {
      reservationId = reserved.body.id;
      counters.inc("reserved");
      reservedSeats = reserved.body.seatIds;
    } else {
      counters.inc(`reserve_${reserved.status}_${reserved.body.reason ?? "?"}`);
    }
  }

  // Paga de verdad: carro → checkout → formulario del adquirente → retorno → orden.
  await sleep(randomInt(Math.max(1, HOLD_MS)));
  if (reservationId) {
    const expected = user.email.endsWith("@acceptme.com") ? "CONFIRMED" : "CANCELLED";
    const final = await pay(client, user, reservationId, ctx);
    counters.inc(`order_${final ?? "SIN_RESULTADO"}`);
    if (final === "CONFIRMED") {
      confirmedOrders.push({ client, code: lastOrderCode.get(client)! });
      confirmedSeats.set(index, reservedSeats);
    }
    if (final !== expected)
      failures.push(`bot ${index} (${user.email}): orden ${final} (esperada ${expected})`);
  }
  // Libera el cupo de la fila para el siguiente (si creó orden, queue ya lo hizo: idempotente).
  if (admission) {
    const done = await client.request("POST", `/queue/events/${ctx.eventId}/complete`);
    counters.inc(done.status === 204 ? "completed" : `complete_${done.status}`);
  }
}

const confirmedOrders: { client: ApiClient; code: string }[] = [];
const lastOrderCode = new Map<ApiClient, string>();

/**
 * Compra como el navegador: agrega la reserva al carro, hace checkout (con clave de idempotencia),
 * "aprieta Pagar" en el formulario de webpay-mock y sigue el retorno a payments. Devuelve el estado
 * final de la orden (la confirma la saga de forma asíncrona).
 */
async function pay(
  client: ApiClient,
  user: BotUser,
  reservationId: string,
  ctx: { eventId: string; dateId: string },
): Promise<string | undefined> {
  const reservation = await client.request<{ ticketTypeId: string; quantity: number }>(
    "GET",
    `/inventory/reservations/${reservationId}`,
  );
  await client.request("POST", "/orders/cart/items", {
    body: {
      replaceEventDateId: ctx.dateId,
      items: [
        {
          key: `res:${reservationId}`,
          kind: "ticket_type",
          itemId: reservation.body.ticketTypeId,
          quantity: reservation.body.quantity,
          reservationId,
          eventId: ctx.eventId,
          eventDateId: ctx.dateId,
          unitPrice: 0,
          unitFee: 0,
        },
      ],
    },
  });
  const checkout = await client.request<{
    orderCode: string;
    redirectUrl: string | null;
    reason?: string;
  }>("POST", "/orders/checkout", {
    body: { buyer: { name: "Bot", email: user.email } },
    headers: { "idempotency-key": randomUUID() },
  });
  latency.checkout.add(checkout.ms);
  if (checkout.status !== 201 || !checkout.body.redirectUrl) {
    counters.inc(`checkout_${checkout.status}_${checkout.body.reason ?? "?"}`);
    return undefined;
  }
  lastOrderCode.set(client, checkout.body.orderCode);
  const started = performance.now();
  const token = new URL(checkout.body.redirectUrl).searchParams.get("token_ws")!;
  // El formulario del adquirente (directo a webpay-mock: Nginx limitaría a los bots por IP).
  const form = await fetch(`${WEBPAY}/webpay/form/pay`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token_ws=${token}`,
    redirect: "manual",
  });
  const returnUrl = new URL(form.headers.get("location") ?? "");
  // return_url pública (Nginx /api) → gateway directo.
  await client.request("GET", `/payments/return${returnUrl.search}`, { redirect: "manual" });
  for (let i = 0; i < 60; i++) {
    const order = await client.request<{ status: string }>(
      "GET",
      `/orders/orders/${checkout.body.orderCode}`,
    );
    if (order.body.status && order.body.status !== "PENDING_PAYMENT") {
      latency.payment.add(performance.now() - started);
      return order.body.status;
    }
    await sleep(250);
  }
  return "PENDING_PAYMENT";
}

async function main() {
  const admin = new ApiClient(args.gateway!, "10.255.255.254");
  const adminUser = { email: args["admin-email"]!, password: args["admin-password"]! };
  if (!(await login(admin, adminUser))) throw new Error("no se pudo iniciar sesión como admin");

  const event = await admin.request<{
    id: string;
    title: string;
    queue: { enabled: boolean; concurrentSlots: number; windowMinutes: number };
    dates: { id: string; ticketTypes: TicketType[] }[];
  }>("GET", `/catalog/events/${args.event}`);
  if (event.status !== 200) throw new Error(`evento ${args.event} no encontrado`);
  const eventId = event.body.id;
  const date = event.body.dates.find((d) => d.id === args.date) ?? event.body.dates[0];
  if (!date) throw new Error("el evento no tiene fechas");

  // Ajuste temporal de la fila (vía catalog, dueño de la configuración).
  const originalQueue = event.body.queue;
  let queue = originalQueue;
  if (args.slots || args.window) {
    const admin2 = await admin.request<{ queue: typeof originalQueue }>(
      "PUT",
      `/catalog/admin/events/${eventId}/queue`,
      {
        body: {
          ...originalQueue,
          enabled: true,
          concurrentSlots: Number(args.slots ?? originalQueue.concurrentSlots),
          windowMinutes: Number(args.window ?? originalQueue.windowMinutes),
        },
      },
    );
    queue = admin2.body.queue;
    await sleep(1500); // queue aplica el cambio al recibir EventoActualizado
  }
  await admin.request("POST", `/queue/admin/events/${eventId}/reset`);

  const seatMap = await admin.request<{
    seats: { id: string; sectionId: string; blocked: boolean }[];
  }>("GET", `/catalog/dates/${date.id}/seat-map`);
  const seatsBySection = new Map<string, string[]>();
  for (const type of date.ticketTypes) {
    seatsBySection.set(
      type.id,
      seatMap.body.seats
        .filter((s) => s.sectionId === type.sectionId && !s.blocked)
        .map((s) => s.id),
    );
  }

  log(
    `evento "${event.body.title}" · fecha ${date.id} · fila ${queue.enabled ? "activa" : "inactiva"} ` +
      `(${queue.concurrentSlots} cupos, ventana ${queue.windowMinutes} min) · ${BOTS} bots en ${RAMP_MS / 1000} s`,
  );
  const users = await ensureUsers(BOTS);

  // Muestreo de admitidos activos (nunca deben superar los cupos).
  let maxActive = 0;
  let maxWaiting = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const stats = await admin.request<{ active: number; waiting: number }>(
        "GET",
        `/queue/admin/events/${eventId}`,
      );
      if (stats.status === 200) {
        maxActive = Math.max(maxActive, stats.body.active);
        maxWaiting = Math.max(maxWaiting, stats.body.waiting);
        if (stats.body.active > queue.concurrentSlots) {
          failures.push(`admitidos activos ${stats.body.active} > cupos ${queue.concurrentSlots}`);
        }
      }
      await sleep(1000);
    }
  })();
  const progress = setInterval(() => {
    log(
      `unidos ${counters.get("joined")} · admitidos ${counters.get("admitted")} · reservas ` +
        `${counters.get("reserved")} · máx. activos ${maxActive}/${queue.concurrentSlots} · máx. en espera ${maxWaiting}`,
    );
  }, 5000);

  // Los usuarios ya están en el sitio con su sesión antes de abrir la venta (como en un peak real,
  // esperan en la prefila): el login no compite con la apertura. Su latencia se reporta aparte.
  log(`iniciando sesión de ${users.length} bots…`);
  const clients: (ApiClient | undefined)[] = new Array(users.length);
  let nextLogin = 0;
  await Promise.all(
    Array.from({ length: Number(args["login-concurrency"]) }, async () => {
      while (nextLogin < users.length) {
        const index = nextLogin++;
        const client = new ApiClient(args.gateway!, botIp(index + 1));
        if (await login(client, users[index]!)) clients[index] = client;
      }
    }),
  );
  log(`${clients.filter(Boolean).length} sesiones activas; abre la venta`);

  const started = performance.now();
  const ctx = { eventId, dateId: date.id, types: date.ticketTypes, seatsBySection };
  await Promise.all(
    users.map(async (user, index) => {
      await sleep((RAMP_MS * index) / BOTS);
      const client = clients[index];
      if (!client) return;
      try {
        await runBot(index, user, ctx, client);
      } catch (error) {
        counters.inc("bot_error");
        failures.push(`bot ${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  sampling = false;
  clearInterval(progress);
  await sampler;

  // 0 sobreventa vista por los compradores: ninguna butaca en dos órdenes confirmadas.
  const owners = new Map<string, number>();
  for (const [bot, seats] of confirmedSeats) {
    for (const seat of seats) {
      const previous = owners.get(seat);
      if (previous !== undefined)
        failures.push(`butaca ${seat} vendida a los bots ${previous} y ${bot}`);
      owners.set(seat, bot);
    }
  }

  const audit = await admin.request<{ ok: boolean; ticketTypes: Record<string, unknown>[] }>(
    "GET",
    `/inventory/admin/audit/events/${eventId}`,
  );
  if (!audit.body.ok)
    failures.push(`auditoría de inventory: ${JSON.stringify(audit.body.ticketTypes)}`);

  // Reservas que no llegaron a orden: se liberan.
  await Promise.all(
    reservationsMade.map(({ id, client }) =>
      client.request("DELETE", `/inventory/reservations/${id}`),
    ),
  );
  const ledger = await admin.request<{ balanced: boolean; balances: Record<string, string> }>(
    "GET",
    "/payments/admin/ledger/check",
  );
  if (!ledger.body.balanced) failures.push(`ledger desbalanceado: ${JSON.stringify(ledger.body)}`);

  if (!args["keep-orders"] && confirmedOrders.length > 0) {
    // Devuelve el cupo para la próxima corrida: reembolso real (payments + inventory).
    log(
      `reembolsando ${confirmedOrders.length} órdenes confirmadas (--keep-orders para conservarlas)…`,
    );
    // Cada bot consulta su propia orden (el listado admin solo trae las más recientes).
    let next = 0;
    let refunded = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < confirmedOrders.length) {
          const { client, code } = confirmedOrders[next++]!;
          const order = await client.request<{ id?: string }>("GET", `/orders/orders/${code}`);
          const refund = order.body.id
            ? await admin.request("POST", `/orders/admin/orders/${order.body.id}/refund`)
            : order;
          if (refund.status === 200) refunded += 1;
          else failures.push(`no se pudo reembolsar ${code}: ${refund.status}`);
        }
      }),
    );
    log(`${refunded}/${confirmedOrders.length} reembolsos pedidos`);
  }
  if (args.slots || args.window) {
    await admin.request("PUT", `/catalog/admin/events/${eventId}/queue`, { body: originalQueue });
  }

  const report = {
    event: args.event,
    bots: BOTS,
    elapsedSeconds: Math.round(elapsed),
    queue: {
      concurrentSlots: queue.concurrentSlots,
      maxActiveObserved: maxActive,
      maxWaitingObserved: maxWaiting,
    },
    admissionThroughputPerSecond: Math.round((counters.get("admitted") / elapsed) * 10) / 10,
    counters: counters.toJSON(),
    latencyMs: Object.fromEntries(Object.entries(latency).map(([name, l]) => [name, l.summary()])),
    inventoryAuditOk: audit.body.ok,
    ledgerBalanced: ledger.body.balanced,
    failures,
  };
  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
  log(
    failures.length === 0
      ? "OK: 0 sobreventas, cupos respetados, pagos coherentes y ledger balanceado"
      : `FALLÓ: ${failures.length} verificaciones`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
