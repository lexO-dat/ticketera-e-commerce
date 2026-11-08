/**
 * Simulador de carga de la fila virtual y la reserva (docs/services/virtual-queue.md).
 *
 * Bots que inician sesión, entran a la fila, consultan respetando Retry-After, y al ser admitidos
 * compiten por butacas reales. Verifica: admitidos activos ≤ cupos, 0 sobreventa (auditoría de
 * inventory) y ninguna butaca entregada a dos bots. Sale con código ≠ 0 si algo falla (sirve en CI).
 *
 *   npm run simulate -w @tools/queue-simulator -- --event lumen-tour-santiago --bots 2000
 */
import { randomBytes, randomInt } from "node:crypto";
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
    "keep-reservations": { type: "boolean", default: false },
    "register-concurrency": { type: "string", default: "16" },
  },
});

const BOTS = Number(args.bots);
const RAMP_MS = Number(args.ramp) * 1000;
const ACCEPT_RATIO = Number(args["accept-ratio"]);
const ABANDON_RATIO = Number(args["abandon-ratio"]);
const HOLD_MS = Number(args["hold-seconds"]) * 1000;
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".data");
const USERS_FILE = join(DATA_DIR, "users.json");

const latency = {
  login: new Latencies(),
  join: new Latencies(),
  status: new Latencies(),
  reserve: new Latencies(),
  waitToAdmission: new Latencies(),
};
const counters = new Counters();
const seatOwners = new Map<string, number>();
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
) {
  const client = new ApiClient(args.gateway!, botIp(index + 1));
  if (!(await login(client, user))) return;
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
      for (const seat of reserved.body.seatIds) {
        const previous = seatOwners.get(seat);
        if (previous !== undefined)
          failures.push(`butaca ${seat} entregada a los bots ${previous} y ${index}`);
        seatOwners.set(seat, index);
      }
      reservationsMade.push({ bot: index, id: reservationId, client });
    } else {
      counters.inc(`reserve_${reserved.status}_${reserved.body.reason ?? "?"}`);
    }
  }

  // "Paga": @acceptme conserva la reserva (el cobro real llega en la Fase 5); @rejectme la libera.
  await sleep(randomInt(Math.max(1, HOLD_MS)));
  if (reservationId && user.email.endsWith("@rejectme.com")) {
    const released = await client.request("DELETE", `/inventory/reservations/${reservationId}`);
    counters.inc(released.status === 204 ? "released_rejected" : `release_${released.status}`);
    for (const [seat, owner] of seatOwners) if (owner === index) seatOwners.delete(seat);
  }
  // Libera el cupo de la fila para el siguiente.
  if (admission) {
    const done = await client.request("POST", `/queue/events/${ctx.eventId}/complete`);
    counters.inc(done.status === 204 ? "completed" : `complete_${done.status}`);
  }
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

  const started = performance.now();
  const ctx = { eventId, dateId: date.id, types: date.ticketTypes, seatsBySection };
  await Promise.all(
    users.map(async (user, index) => {
      await sleep((RAMP_MS * index) / BOTS);
      try {
        await runBot(index, user, ctx);
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

  const audit = await admin.request<{ ok: boolean; ticketTypes: Record<string, unknown>[] }>(
    "GET",
    `/inventory/admin/audit/events/${eventId}`,
  );
  if (!audit.body.ok)
    failures.push(`auditoría de inventory: ${JSON.stringify(audit.body.ticketTypes)}`);

  if (!args["keep-reservations"]) {
    // Devuelve el cupo para la próxima corrida.
    await Promise.all(
      reservationsMade.map(({ id, client }) =>
        client.request("DELETE", `/inventory/reservations/${id}`),
      ),
    );
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
    failures,
  };
  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
  log(
    failures.length === 0
      ? "OK: 0 sobreventas, cupos respetados"
      : `FALLÓ: ${failures.length} verificaciones`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
