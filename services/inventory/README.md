# inventory — disponibilidad y reservas

Implementa [ADR-03](../../docs/adr/ADR-03-reserva-bloqueo-pesimista.md) (RF05, RF07). Reemplaza
`seat_holds` del prototipo. Contrato:
[`packages/contracts/openapi/inventory.yaml`](../../packages/contracts/openapi/inventory.yaml).
Público vía gateway: `/inventory/*` → `/v1/*`.

| Tema                | Implementación                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 % sobreventa      | Una transacción por reserva: `SELECT … FOR UPDATE` sobre el tipo de entrada; contador con `UPDATE … WHERE sold + reserved + n <= capacity`; índice único parcial `(fecha, butaca) WHERE holding` como última defensa                        |
| Reserva exclusiva   | 10 min (`RESERVATION_TTL_SECONDS`). Máximo 8 entradas por usuario y función (con lock consultivo por usuario)                                                                                                                               |
| Expiración perezosa | Una reserva vencida deja de contar en cuanto se consulta o se intenta reservar; el barrido (cada 2 s, una réplica con lock en Redis) devuelve el cupo y publica `ReservaLiberada`                                                           |
| Liberación          | `DELETE /v1/reservations/:id` (solo el dueño): inmediata, en la misma transacción que el contador                                                                                                                                           |
| Fila virtual        | En eventos con fila exige `X-Admission-Token`: firma (JWKS de queue), mismo usuario y evento, y `jti` vigente en Redis                                                                                                                      |
| Catálogo            | Proyección local (`event_projection`, `ticket_inventory`) actualizada con `EventoActualizado` / `EventoEliminado` (inbox, orden por `occurredAt`); si falta, se completa leyendo catalog. Las butacas se validan contra el plano de catalog |
| Lecturas públicas   | Disponibilidad por tipo de entrada y butacas ocupadas con micro-caché de 1 s en Redis; la reserva siempre decide en la BD                                                                                                                   |
| Auditoría           | `GET /v1/admin/audit/events/:id` (admin): sobreventa, butacas duplicadas y deriva de contadores. La usa el simulador                                                                                                                        |
| Saga (orders)       | `/internal/reservations/*` con `x-internal-token`: consultar, **vender todo o nada** (idempotente por orden; falla si alguna venció → reembolso), liberar por pago fallido y devolver lo vendido tras un reembolso                          |
| Eventos             | Outbox: `ReservaCreada`, `ReservaLiberada` (`USER` / `EXPIRED` / `PAYMENT_FAILED` / `REFUNDED`…), `ReservaVendida`                                                                                                                          |

```bash
npm run infra:up                      # ya incluye inventory (2 réplicas)
TEST_DATABASE_URL=postgres://commons_test:commons_test-dev-password@127.0.0.1:5432/commons_test \
TEST_REDIS_URL=redis://:redis-dev-password@127.0.0.1:6379 npm test -w @services/inventory
```
