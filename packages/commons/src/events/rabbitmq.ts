import amqp, {
  type Channel,
  type ConfirmChannel,
  type ConsumeMessage,
  type RecoveringChannelModel,
} from "amqplib";
import type { Logger } from "pino";
import { AppError } from "../errors.js";
import { backoffDelay, sleep } from "../retry.js";
import { type EventEnvelope, parseEvent, routingKeyFor } from "./envelope.js";

/** Exchange de tópicos donde se publican todos los eventos de dominio. */
export const EVENTS_EXCHANGE = "ticketera.events";
/** Exchange de mensajes que agotaron sus reintentos o son inválidos. */
export const DEAD_LETTER_EXCHANGE = "ticketera.dead-letter";

export type EventHandler = (event: EventEnvelope, message: ConsumeMessage) => Promise<void>;

export interface Subscription {
  /** Cola durable del consumidor, p. ej. `tickets.order-confirmed`. Una por servicio y propósito. */
  queue: string;
  /** Patrones de tópico, p. ej. `orders.OrdenConfirmada.*`. */
  bindings: string[];
  handler: EventHandler;
  /** Mensajes en vuelo por consumidor. */
  prefetch?: number;
  /** Intentos de procesamiento antes de mandar el mensaje a `<queue>.dlq`. */
  maxDeliveries?: number;
}

export interface EventBusOptions {
  url: string;
  logger: Logger;
  /** Nombre de la conexión visible en la consola de RabbitMQ. */
  connectionName: string;
  /** Tiempo máximo esperando la confirmación del broker al publicar. */
  publishTimeoutMs?: number;
}

/**
 * Bus de eventos sobre RabbitMQ: publicación con _publisher confirms_ y consumo con ack manual,
 * colas quorum, reintentos con backoff y _dead letter_. Se reconecta solo; tras reconectar vuelve a
 * declarar la topología y los consumidores.
 *
 * La entrega es _al menos una vez_: los consumidores deben ser idempotentes (ver `db/inbox`).
 */
export class RabbitEventBus {
  private publishChannel: ConfirmChannel | undefined;
  private consumeChannels: Channel[] = [];
  private readonly subscriptions: Subscription[] = [];
  private connected = false;
  private closing = false;
  private readonly publishTimeoutMs: number;

  private constructor(
    private readonly model: RecoveringChannelModel,
    private readonly options: EventBusOptions,
  ) {
    this.publishTimeoutMs = options.publishTimeoutMs ?? 5_000;
  }

  static async connect(options: EventBusOptions): Promise<RabbitEventBus> {
    const model = await amqp.connect(options.url, {
      clientProperties: { connection_name: options.connectionName },
      recovery: {
        initialDelay: 200,
        maxDelay: 10_000,
        initialMaxRetries: 10,
        waitForConnect: false,
      },
    });
    const bus = new RabbitEventBus(model, options);
    model.on("connect", () => {
      bus.readyPromise = bus.onConnect();
      bus.readyPromise.catch((error: unknown) => {
        options.logger.error({ err: error }, "rabbitmq: no se pudo preparar la topología");
      });
    });
    model.on("disconnect", (error: Error) => {
      bus.connected = false;
      bus.publishChannel = undefined;
      bus.consumeChannels = [];
      if (!bus.closing)
        options.logger.warn({ err: error }, "rabbitmq: conexión perdida, reintentando");
    });
    model.on("error", (error: Error) => options.logger.error({ err: error }, "rabbitmq: error"));
    await model.waitForConnect();
    await (bus.readyPromise ?? bus.onConnect());
    return bus;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Publica y espera la confirmación del broker. Si no hay conexión, falla (el outbox reintenta). */
  async publish(event: EventEnvelope): Promise<void> {
    const channel = this.publishChannel;
    if (!channel || !this.connected) throw AppError.unavailable("Broker de eventos no disponible");
    const body = Buffer.from(JSON.stringify(event));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(AppError.unavailable("El broker no confirmó la publicación")),
        this.publishTimeoutMs,
      );
      channel.publish(
        EVENTS_EXCHANGE,
        routingKeyFor(event),
        body,
        {
          persistent: true,
          contentType: "application/json",
          messageId: event.id,
          type: event.type,
          appId: event.source,
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
          ...(event.correlationId ? { correlationId: event.correlationId } : {}),
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (error) reject(AppError.unavailable("El broker rechazó la publicación"));
          else resolve();
        },
      );
    });
  }

  async subscribe(subscription: Subscription): Promise<void> {
    this.subscriptions.push(subscription);
    if (this.connected) await this.startConsumer(subscription);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.connected = false;
    await this.model.close().catch(() => undefined);
  }

  private readyPromise: Promise<void> | undefined;
  private setupInFlight: Promise<void> | undefined;

  private onConnect(): Promise<void> {
    // Evita preparar dos veces si `connect` y `ready()` coinciden.
    this.setupInFlight ??= this.setup().finally(() => {
      this.setupInFlight = undefined;
    });
    return this.setupInFlight;
  }

  private async setup(): Promise<void> {
    const channel = await this.model.createConfirmChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, "direct", { durable: true });
    this.publishChannel = channel;
    this.consumeChannels = [];
    this.connected = true;
    for (const subscription of this.subscriptions) await this.startConsumer(subscription);
    this.options.logger.info("rabbitmq: conectado");
  }

  private async startConsumer(subscription: Subscription): Promise<void> {
    const { queue, bindings, prefetch = 10 } = subscription;
    const channel = await this.model.createChannel();
    this.consumeChannels.push(channel);
    await channel.assertQueue(`${queue}.dlq`, {
      durable: true,
      arguments: { "x-queue-type": "quorum" },
    });
    await channel.bindQueue(`${queue}.dlq`, DEAD_LETTER_EXCHANGE, queue);
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        // Red de seguridad para mensajes que botan el proceso una y otra vez (no llegan al catch).
        "x-delivery-limit": POISON_DELIVERY_LIMIT,
        "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE,
        "x-dead-letter-routing-key": queue,
      },
    });
    for (const pattern of bindings) await channel.bindQueue(queue, EVENTS_EXCHANGE, pattern);
    await channel.prefetch(prefetch);
    await channel.consume(queue, (message) => {
      if (message) void this.handle(channel, subscription, message);
    });
  }

  private async handle(channel: Channel, subscription: Subscription, message: ConsumeMessage) {
    const log = this.options.logger.child({
      queue: subscription.queue,
      messageId: message.properties.messageId,
    });
    let event: EventEnvelope;
    try {
      event = parseEvent(JSON.parse(message.content.toString("utf8")));
    } catch (error) {
      log.error({ err: error }, "evento inválido: se envía a la DLQ");
      safely(() => channel.nack(message, false, false));
      return;
    }
    try {
      await subscription.handler(event, message);
      safely(() => channel.ack(message));
    } catch (error) {
      const attempt = Number(message.properties.headers?.[RETRY_HEADER] ?? 0) + 1;
      const maxAttempts = subscription.maxDeliveries ?? 10;
      if (attempt >= maxAttempts) {
        log.error(
          { err: error, eventType: event.type, attempt },
          "evento agotó sus reintentos: DLQ",
        );
        safely(() => channel.nack(message, false, false));
        return;
      }
      log.warn(
        { err: error, eventType: event.type, attempt },
        "fallo al procesar evento, se reintenta",
      );
      // Backoff (ocupa un slot de prefetch: frena el consumo mientras la dependencia falla).
      await sleep(backoffDelay(attempt, 200, 10_000));
      try {
        // Copia con el contador de intentos al final de la cola y luego ack del original.
        // Si el proceso cae entre ambos pasos, el evento llega dos veces: el consumidor es idempotente.
        await this.republish(subscription.queue, message, attempt);
        safely(() => channel.ack(message));
      } catch {
        // Sin broker: devolverlo tal cual; se reentregará al reconectar.
        safely(() => channel.nack(message, false, true));
      }
    }
  }

  private republish(queue: string, message: ConsumeMessage, attempt: number): Promise<void> {
    const channel = this.publishChannel;
    if (!channel) return Promise.reject(new Error("sin canal de publicación"));
    return new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        queue,
        message.content,
        {
          ...message.properties,
          headers: { ...message.properties.headers, [RETRY_HEADER]: attempt },
        },
        (error: unknown) => (error ? reject(new Error("republicación rechazada")) : resolve()),
      );
    });
  }
}

/** Intentos ya fallidos de un mensaje (lo pone el bus al reintentar). */
const RETRY_HEADER = "x-retry-count";
const POISON_DELIVERY_LIMIT = 20;

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Canal cerrado: el broker reentregará el mensaje no confirmado.
  }
}
