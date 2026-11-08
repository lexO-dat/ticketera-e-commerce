/**
 * Fila virtual contra Redis real (TEST_REDIS_URL). Las pruebas obligatorias de
 * docs/services/virtual-queue.md: join concurrente, admisores en paralelo sin admitir de más,
 * vencimiento que libera y revoca, token ligado a usuario y evento.
 */
import { generateKeyPairSync } from "node:crypto";
import { type EventEnvelope, createLogger, newId } from "@shared/commons";
import {
  admissionJtiKey,
  createAdmissionVerifier,
  createTokenVerifier,
  localKeySet,
} from "@shared/commons/auth";
import { type Redis, createRedis } from "@shared/commons/redis";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { configFromCatalogEvent } from "../src/catalog-events.js";
import type { EventConfigSource, QueueConfig } from "../src/event-config.js";
import { createQueueService, estimateEta, retryAfterFor, secureShuffle } from "../src/queue.js";
import { createAdmissionSigner } from "../src/tokens.js";

const REDIS_URL = process.env.TEST_REDIS_URL;
const logger = createLogger({ service: "queue-test", level: "silent" });

describe("cálculos de la sala de espera", () => {
  const config: QueueConfig = {
    eventId: "e",
    enabled: true,
    published: true,
    opensAt: null,
    concurrentSlots: 100,
    windowMinutes: 10,
    admitBatchMax: 50,
    waitingMessage: null,
  };

  it("Retry-After crece con la distancia al frente", () => {
    expect(retryAfterFor(1, 100)).toBe(2);
    expect(retryAfterFor(500, 100)).toBe(5);
    expect(retryAfterFor(5000, 100)).toBe(10);
  });

  it("ETA con la tasa real o, sin historial, con la liberación por ventana", () => {
    expect(estimateEta(99, 10, config)).toBe(10);
    // 100 cupos / 600 s ≈ 0,167 admisiones por segundo.
    expect(estimateEta(99, 0, config)).toBe(600);
  });

  it("baraja sin perder ni duplicar elementos", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const shuffled = secureShuffle(items);
    expect(new Set(shuffled).size).toBe(1000);
    expect(shuffled).not.toEqual(items);
  });

  it("aplica la configuración que llega de catalog", () => {
    const base = {
      id: newId(),
      version: 1,
      source: "catalog",
      occurredAt: new Date().toISOString(),
    };
    const updated = configFromCatalogEvent({
      ...base,
      type: "EventoActualizado",
      aggregateId: "e1",
      data: {
        eventId: "e1",
        status: "published",
        queue: {
          enabled: true,
          opensAt: null,
          concurrentSlots: 5,
          windowMinutes: 3,
          admitBatchMax: 2,
          waitingMessage: "hola",
        },
      },
    } as EventEnvelope);
    expect(updated).toMatchObject({ eventId: "e1", enabled: true, concurrentSlots: 5 });
    const draft = configFromCatalogEvent({
      ...base,
      type: "EventoActualizado",
      aggregateId: "e1",
      data: { eventId: "e1", status: "draft", queue: { ...updated, opensAt: null } },
    } as unknown as EventEnvelope);
    expect(draft).toMatchObject({ enabled: false, published: false });
    const removed = configFromCatalogEvent({
      ...base,
      type: "EventoEliminado",
      aggregateId: "e1",
      data: { eventId: "e1" },
    } as EventEnvelope);
    expect(removed).toMatchObject({ enabled: false, published: false });
  });
});

describe.skipIf(!REDIS_URL)("queue (integración con Redis)", () => {
  let redis: Redis;
  let clock = Date.now();
  const published: EventEnvelope[] = [];
  const publisher = { publish: async (event: EventEnvelope) => void published.push(event) };
  const configs = new Map<string, QueueConfig>();
  const configSource: EventConfigSource = {
    get: async (eventId) =>
      configs.get(eventId) ?? {
        eventId,
        enabled: false,
        published: false,
        opensAt: null,
        concurrentSlots: 0,
        windowMinutes: 10,
        admitBatchMax: 50,
        waitingMessage: null,
      },
    apply: async (config) => void configs.set(config.eventId, config),
  };
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const usedEvents: string[] = [];

  function eventWith(overrides: Partial<QueueConfig> = {}): string {
    const eventId = newId();
    usedEvents.push(eventId);
    configs.set(eventId, {
      eventId,
      enabled: true,
      published: true,
      opensAt: null,
      concurrentSlots: 3,
      windowMinutes: 10,
      admitBatchMax: 50,
      waitingMessage: "Espera",
      ...overrides,
    });
    return eventId;
  }

  async function service() {
    return createQueueService({
      redis,
      configs: configSource,
      signer: await createAdmissionSigner(pem.toString(), "test"),
      publisher,
      logger,
      heartbeatTimeoutSeconds: 60,
      now: () => clock,
    });
  }

  beforeAll(() => {
    redis = createRedis({ url: REDIS_URL!, connectionName: "queue-test", logger });
  });

  afterAll(async () => {
    const queue = await service();
    for (const eventId of usedEvents) await queue.reset(eventId);
    await redis.quit();
  });

  it("join concurrente del mismo usuario crea un solo turno; el resto respeta la llegada", async () => {
    const queue = await service();
    const eventId = eventWith({ concurrentSlots: 1 });
    const user = newId();
    const results = await Promise.all(Array.from({ length: 30 }, () => queue.join(user, eventId)));
    expect(new Set(results.map((r) => r.position))).toEqual(new Set([1]));
    expect(
      published.filter((e) => e.type === "TurnoCreado" && e.aggregateId === eventId),
    ).toHaveLength(1);

    const others = [newId(), newId(), newId()];
    for (const other of others) await queue.join(other, eventId);
    const positions = await Promise.all(others.map((other) => queue.status(other, eventId)));
    expect(positions.map((p) => p.position)).toEqual([2, 3, 4]);
    expect(positions[2]).toMatchObject({ state: "WAITING", ahead: 3, retryAfterSeconds: 5 });
  });

  it("varios admisores en paralelo nunca superan los cupos", async () => {
    const replicas = await Promise.all([service(), service(), service()]);
    const eventId = eventWith({ concurrentSlots: 7, admitBatchMax: 50 });
    const users = Array.from({ length: 60 }, () => newId());
    await Promise.all(users.map((user) => replicas[0]!.join(user, eventId)));
    for (let round = 0; round < 5; round++) {
      await Promise.all(replicas.map((replica) => replica.tick()));
      const stats = await replicas[0]!.stats(eventId);
      expect(stats.active).toBeLessThanOrEqual(7);
    }
    const stats = await replicas[0]!.stats(eventId);
    expect(stats).toMatchObject({ active: 7, waiting: 53 });
    // Los admitidos son los primeros en llegar (FIFO).
    const states = await Promise.all(
      users.slice(0, 8).map((user) => replicas[1]!.status(user, eventId)),
    );
    expect(states.slice(0, 7).every((s) => s.state === "ADMITTED")).toBe(true);
    expect(states[7]!.state).toBe("WAITING");
    for (const replica of replicas) await replica.stop();
  });

  it("el token de admisión queda ligado a usuario y evento, y su jti vive en Redis", async () => {
    const queue = await service();
    const eventId = eventWith();
    const user = newId();
    await queue.join(user, eventId);
    await queue.tick();
    const status = await queue.status(user, eventId);
    expect(status.state).toBe("ADMITTED");
    const signer = await createAdmissionSigner(pem.toString(), "test");
    const verify = createAdmissionVerifier({ getKey: localKeySet(signer.jwks()) });
    const admission = await verify(status.admissionToken!);
    expect(admission).toMatchObject({ userId: user, eventId });
    expect(await redis.get(admissionJtiKey(eventId, admission.jti))).toBe(user);

    const other = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const foreign = await createAdmissionSigner(other.toString(), "test");
    const forged = await foreign.sign({
      userId: user,
      eventId,
      jti: admission.jti,
      expiresAt: clock + 60_000,
    });
    await expect(verify(forged)).rejects.toMatchObject({ reason: "ADMISSION_REQUIRED" });
    await queue.stop();
  });

  it("al vencer la ventana se libera el cupo, se revoca el jti y entra el siguiente", async () => {
    const queue = await service();
    const eventId = eventWith({ concurrentSlots: 1, windowMinutes: 1 });
    const [first, second] = [newId(), newId()];
    await queue.join(first, eventId);
    await queue.join(second, eventId);
    await queue.tick();
    const admitted = await queue.status(first, eventId);
    const jti = (await redis.hget(`q:{${eventId}}:turn:${first}`, "jti"))!;
    expect(admitted.state).toBe("ADMITTED");

    clock += 61_000;
    await queue.status(second, eventId); // heartbeat del que espera
    await queue.tick();
    expect((await queue.status(first, eventId)).state).toBe("EXPIRED");
    expect(await redis.exists(admissionJtiKey(eventId, jti))).toBe(0);
    expect((await queue.status(second, eventId)).state).toBe("ADMITTED");
    expect(published.some((e) => e.type === "TurnoVencido" && e.data["jti"] === jti)).toBe(true);
    await queue.stop();
  });

  it("completar libera el cupo al instante; quien dejó de consultar pierde el turno", async () => {
    const queue = await service();
    const eventId = eventWith({ concurrentSlots: 1 });
    const [buyer, ghost, next] = [newId(), newId(), newId()];
    await queue.join(buyer, eventId);
    await queue.tick();
    await queue.join(ghost, eventId);
    clock += 30_000;
    await queue.join(next, eventId);
    clock += 40_000; // ghost lleva 70 s sin consultar; next, 40 s
    expect(await queue.complete(buyer, eventId)).toBe(true);
    expect(await queue.complete(buyer, eventId)).toBe(false);
    await queue.tick();
    expect((await queue.status(ghost, eventId)).state).toBe("ABANDONED");
    expect((await queue.status(next, eventId)).state).toBe("ADMITTED");
    await queue.stop();
  });

  it("la prefila se aleatoriza al abrir y queda delante de quienes llegan después", async () => {
    const queue = await service();
    const eventId = eventWith({ concurrentSlots: 1000, admitBatchMax: 1, opensAt: clock + 60_000 });
    const early = Array.from({ length: 40 }, () => newId());
    for (const user of early) await queue.join(user, eventId);
    expect((await queue.status(early[0]!, eventId)).state).toBe("PREQUEUE");
    await queue.tick();
    expect((await queue.stats(eventId)).prequeue).toBe(40);

    clock += 61_000;
    // Los clientes reales consultan cada ≤ 10 s en la prefila (heartbeat).
    await Promise.all(early.map((user) => queue.status(user, eventId)));
    const late = newId();
    await queue.join(late, eventId);
    await queue.tick(); // abre: baraja la prefila y admite 1
    const positions = await Promise.all(early.map((user) => queue.status(user, eventId)));
    const waitingPositions = positions.filter((p) => p.state === "WAITING").map((p) => p.position!);
    expect(waitingPositions).toHaveLength(39);
    expect((await queue.status(late, eventId)).position).toBe(40);
    // El orden de llegada a la prefila no se conserva (aleatorio).
    const order = positions.map((p) => p.position ?? 0);
    expect(order).not.toEqual([...order].sort((a, b) => a - b));
    await queue.stop();
  });

  it("sin fila activa no exige turno; evento inexistente responde 404", async () => {
    const queue = await service();
    const eventId = eventWith({ enabled: false });
    expect((await queue.join(newId(), eventId)).state).toBe("NOT_REQUIRED");
    await expect(queue.join(newId(), newId())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("API HTTP: sesión obligatoria, Retry-After y administración solo para admin", async () => {
    const keyPair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwks = { keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "k1", alg: "EdDSA" }] };
    const token = (sub: string, roles: string[]) =>
      new SignJWT({ roles, email_verified: true })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer("ticketera-identity")
        .setAudience("ticketera")
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keyPair.privateKey);
    const queue = await service();
    const app = buildApp({
      logger,
      queue,
      signer: await createAdmissionSigner(pem.toString(), "test"),
      verifyToken: createTokenVerifier({ getKey: localKeySet(jwks) }),
    });
    const eventId = eventWith({ concurrentSlots: 1 });
    const customer = await token(newId(), ["customer"]);

    expect(
      (await app.inject({ method: "POST", url: `/v1/events/${eventId}/join` })).statusCode,
    ).toBe(401);
    const joined = await app.inject({
      method: "POST",
      url: `/v1/events/${eventId}/join`,
      headers: { authorization: `Bearer ${customer}` },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ state: "WAITING", position: 1 });
    expect(joined.headers["retry-after"]).toBe("2");
    expect(joined.headers["cache-control"]).toBe("no-store");

    const jwksResponse = await app.inject({ url: "/.well-known/jwks.json" });
    expect(jwksResponse.json().keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", kid: "test" });
    expect(jwksResponse.json().keys[0]).not.toHaveProperty("d");

    const adminUrl = `/v1/admin/events/${eventId}`;
    expect(
      (await app.inject({ url: adminUrl, headers: { authorization: `Bearer ${customer}` } }))
        .statusCode,
    ).toBe(403);
    const admin = await token(newId(), ["admin"]);
    const stats = await app.inject({
      url: adminUrl,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(stats.json()).toMatchObject({ waiting: 1, active: 0 });
    await app.close();
  });

  it("si Redis no responde la fila se cierra (503), no admite sin control", async () => {
    const broken = createRedis({
      url: "redis://127.0.0.1:1",
      connectionName: "queue-test-broken",
      logger,
      options: { maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false },
    });
    const queue = createQueueService({
      redis: broken,
      configs: configSource,
      signer: await createAdmissionSigner(pem.toString(), "test"),
      publisher,
      logger,
      heartbeatTimeoutSeconds: 60,
    });
    const eventId = eventWith();
    await expect(queue.join(newId(), eventId)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await expect(queue.status(newId(), eventId)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    broken.disconnect();
  });
});
