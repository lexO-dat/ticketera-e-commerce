// Núcleo sin dependencias de infraestructura. BD, eventos, Redis y HTTP están en sus subrutas:
// `@shared/commons/db`, `@shared/commons/events`, `@shared/commons/redis`, `@shared/commons/http`.
export * from "./config.js";
export * from "./errors.js";
export * from "./ids.js";
export * from "./item-vendible.js";
export * from "./logger.js";
export * from "./money.js";
export * from "./retry.js";
export { createEvent, eventEnvelopeSchema, parseEvent, routingKeyFor } from "./events/envelope.js";
export type { EventEnvelope, NewEvent } from "./events/envelope.js";
