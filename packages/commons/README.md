# @shared/commons

Librería compartida por los servicios Node. Se consume como TypeScript (sin build propio): en
desarrollo con `tsx`/Vitest y en producción queda dentro del bundle de cada servicio (`tsup`).

| Import                   | Contenido                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@shared/commons`        | `AppError` + RFC 9457, `SellableItem` (`ItemVendible`), CLP en `bigint`, ids/códigos seguros, logger con redacción, `loadConfig`, `retry`, `CircuitBreaker`, sobre de eventos |
| `@shared/commons/db`     | Pool de Postgres (`bigint` → `BigInt`), `withTransaction` con reintento ante _deadlock_/serialización, migraciones SQL con _advisory lock_, outbox + relay, inbox             |
| `@shared/commons/events` | `RabbitEventBus`: _publisher confirms_, colas quorum, reintentos con backoff, DLQ, reconexión                                                                                 |
| `@shared/commons/redis`  | Cliente Redis y lock distribuido (`acquireLock`, `withLock`) para jobs de una sola réplica                                                                                    |
| `@shared/commons/http`   | `createServer` (Fastify con request-id, errores, health checks) y `runService` (apagado limpio)                                                                               |

Reglas que encapsula (ver `AGENTS.md` §8): montos nunca en `number` con decimales, códigos con
`crypto.randomBytes`, logs sin secretos, errores 5xx sin detalle, eventos solo vía outbox.

## Pruebas

```bash
npm test -w @shared/commons            # unitarias
npm run infra:up                       # Postgres, Redis y RabbitMQ locales
TEST_DATABASE_URL=postgres://commons_test:commons_test-dev-password@127.0.0.1:5432/commons_test \
TEST_REDIS_URL=redis://:redis-dev-password@127.0.0.1:6379 \
TEST_AMQP_URL=amqp://ticketera:rabbitmq-dev-password@127.0.0.1:5672 \
  npm test -w @shared/commons          # + integración (concurrencia, outbox, DLQ, locks)
```
