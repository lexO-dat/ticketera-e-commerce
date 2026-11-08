# orders — carro, checkout, órdenes y promociones

RF06, RF08, RF10, RF12. Orquesta la saga de compra
([`docs/services/payments.md` §7](../../docs/services/payments.md)). Contrato:
[`packages/contracts/openapi/orders.yaml`](../../packages/contracts/openapi/orders.yaml).

| Tema            | Implementación                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Carro           | Redis replicado (ADR-01): sobrevive a recargar y al failover. Cada línea de entradas está respaldada por una reserva de inventory                                                                         |
| Checkout        | `Idempotency-Key` obligatoria. Valida que las reservas sean del usuario y estén vigentes; precios desde catalog (`ItemVendible`, cualquier tipo de ítem); crea la orden `PENDING_PAYMENT` y pide el cobro |
| Promociones     | Consumo atómico (`UPDATE … WHERE used_count < max_uses`) en la misma transacción que la orden; se devuelven si la orden se cancela                                                                        |
| Saga            | `PagoAutorizado` → inventory vende todo o nada → `CONFIRMED` + `OrdenConfirmada` (con las líneas para tickets). `PagoRechazado` → `CANCELLED` y libera las reservas al instante                           |
| Pago tardío     | Aprobado con la reserva vencida (o la orden ya cancelada) → `REFUND_PENDING` y reembolso automático; nunca se cobra sin entregar                                                                          |
| Reembolso admin | Orden confirmada → payments reembolsa → `REFUNDED` y inventory devuelve el cupo                                                                                                                           |
| Consistencia    | Consumidor con inbox; cambios de estado compare-and-set; llamadas a otros servicios con clave idempotente, reintentos, backoff y circuit breaker                                                          |
| Fila virtual    | `OrdenCreada` lleva los eventos de la orden: queue libera el turno del comprador                                                                                                                          |
| Autenticación   | `/v1/*` con sesión (solo el dueño ve su orden); `/internal/*` con `x-internal-token` (payments)                                                                                                           |

Datos de demostración (`SEED_DEMO_DATA=true`): los códigos `PRIMERAFILA`, `CLUB2026` e `INVIERNO`
del prototipo.

```bash
TEST_DATABASE_URL=postgres://commons_test:commons_test-dev-password@127.0.0.1:5432/commons_test \
TEST_REDIS_URL=redis://:redis-dev-password@127.0.0.1:6379 npm test -w @services/orders
```
