# Ticketera — Plataforma de e-commerce y ticketing

Proyecto de Arquitectura de Software (UDP, Sección 2).

- Guía para contribuir y reglas: [`AGENTS.md`](AGENTS.md)
- Arquitectura (4+1, ADR): [`docs/architecture`](docs/architecture/README.md) · [`docs/adr`](docs/adr/README.md)
- Hoja de ruta: [`roadmap.md`](roadmap.md)

## Puesta en marcha

Requisitos: Node 22.18+, Docker con Compose.

```bash
npm install
npm run infra:up      # Postgres primaria+réplica, Redis+réplica, RabbitMQ, Mailpit, Nginx (TLS 1.3)
npm run dev           # web (TanStack Start) en http://localhost:8080 · vía Nginx: https://localhost:8443
```

| Servicio local                | Dirección                                   | Credenciales de desarrollo                                                                                      |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| PostgreSQL primaria / réplica | `127.0.0.1:5432` / `:5433`                  | `postgres` / `postgres-dev-password`; una base y un rol por servicio (`<servicio>` / `<servicio>-dev-password`) |
| Redis primario / réplica      | `127.0.0.1:6379` / `:6380`                  | contraseña `redis-dev-password`                                                                                 |
| RabbitMQ (AMQP / consola)     | `127.0.0.1:5672` / http://localhost:15672   | `ticketera` / `rabbitmq-dev-password`                                                                           |
| Mailpit (SMTP / bandeja)      | `127.0.0.1:1025` / http://localhost:8025    | —                                                                                                               |
| Nginx (borde TLS 1.3)         | https://localhost:8443 (`/api/*` → gateway) | certificado autofirmado                                                                                         |

Se sobrescriben con `infra/.env` (ver `infra/.env.example`).

## Monorepo

| Ruta                 | Contenido                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `src/`               | Web actual (TanStack Start); se mueve a `apps/web` al terminar la migración (patrón _strangler_)  |
| `packages/commons`   | `@shared/commons`: errores, `ItemVendible`, CLP, logger, BD/outbox, eventos, Redis, servidor HTTP |
| `packages/contracts` | `@shared/contracts`: OpenAPI y AsyncAPI                                                           |
| `services/template`  | Plantilla de servicio; `npm run new:service -- <nombre>` crea uno nuevo                           |
| `infra/`             | `docker-compose.yml`, Postgres (réplica síncrona), Nginx                                          |

| Comando                                           | Qué hace                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                               | Web + todos los workspaces                                                                        |
| `npm test`                                        | Tests de todos los workspaces (integración si hay `TEST_*_URL`, ver `packages/commons/README.md`) |
| `npm run lint:backend`                            | ESLint de `packages`, `services`, `tools`, `scripts`                                              |
| `npm run build:backend`                           | Bundle de cada servicio                                                                           |
| `npm run infra:up` / `infra:down` / `infra:reset` | Levanta, detiene o borra la infraestructura local                                                 |
