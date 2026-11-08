/**
 * Catálogo de eventos de dominio (fuente: `asyncapi/events.yaml`). Los nombres están en el
 * lenguaje del dominio, como en la vista de procesos. Un test verifica que este catálogo y el
 * documento AsyncAPI no se desalineen.
 *
 * Clave de enrutamiento en RabbitMQ: `<source>.<type>.v<version>` (exchange `ticketera.events`).
 */
export const DomainEvents = {
  // catalog (ADR-05: estado completo del agregado en cada cambio)
  EventoActualizado: { source: "catalog", version: 1 },
  EventoEliminado: { source: "catalog", version: 1 },
  ProductoActualizado: { source: "catalog", version: 1 },
  ProductoEliminado: { source: "catalog", version: 1 },
  // queue (ADR-06)
  TurnoCreado: { source: "queue", version: 1 },
  TurnoAdmitido: { source: "queue", version: 1 },
  TurnoVencido: { source: "queue", version: 1 },
  TurnoCompletado: { source: "queue", version: 1 },
  // inventory (ADR-03)
  ReservaCreada: { source: "inventory", version: 1 },
  ReservaLiberada: { source: "inventory", version: 1 },
  ReservaVendida: { source: "inventory", version: 1 },
  // orders
  OrdenCreada: { source: "orders", version: 1 },
  OrdenConfirmada: { source: "orders", version: 1 },
  OrdenCancelada: { source: "orders", version: 1 },
  // payments (ADR-07)
  PagoAutorizado: { source: "payments", version: 1 },
  PagoRechazado: { source: "payments", version: 1 },
  PagoReembolsado: { source: "payments", version: 1 },
  // tickets
  EntradasEmitidas: { source: "tickets", version: 1 },
  EntradaValidada: { source: "tickets", version: 1 },
  // identity
  UsuarioRegistrado: { source: "identity", version: 1 },
  VerificacionEmailSolicitada: { source: "identity", version: 1 },
  RecuperacionContrasenaSolicitada: { source: "identity", version: 1 },
} as const satisfies Record<string, { source: string; version: number }>;

export type DomainEventType = keyof typeof DomainEvents;

export function routingKey(type: DomainEventType): string {
  const { source, version } = DomainEvents[type];
  return `${source}.${type}.v${version}`;
}

/** Patrón de suscripción a todas las versiones de un evento. */
export function bindingFor(type: DomainEventType): string {
  return `${DomainEvents[type].source}.${type}.*`;
}

/** Servicios con contrato HTTP en `openapi/<servicio>.yaml`. */
export const HttpServices = [
  "template",
  "identity",
  "gateway",
  "catalog",
  "queue",
  "inventory",
  "webpay-mock",
  "payments",
  "orders",
  "tickets",
] as const;
