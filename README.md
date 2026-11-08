# Ticketera — Plataforma de e-commerce y ticketing

Proyecto de Arquitectura de Software (UDP, Sección 2).

- Guía para contribuir y reglas: [`AGENTS.md`](AGENTS.md)
- Arquitectura (4+1, ADR): [`docs/architecture`](docs/architecture/README.md) · [`docs/adr`](docs/adr/README.md)
- Hoja de ruta: [`roadmap.md`](roadmap.md)

## Puesta en marcha

Requisitos: Node 22.18+, Docker con Compose.

```bash
npm install
npm run infra:up      # infraestructura + todos los servicios (2 réplicas c/u) + gateway
cp .env.example .env  # la web habla con el gateway en GATEWAY_URL
npm run dev           # web (TanStack Start) en http://localhost:8080 · vía Nginx: https://localhost:8443
```

Administrador de desarrollo: `admin@ticketera.local` / `admin-dev-password-123`. Los correos
(verificación, recuperación de contraseña, compra, entradas con QR, cancelaciones y reembolsos) los
envía `notifications` y en desarrollo llegan a Mailpit: http://localhost:8025. Para usar un proveedor
real basta con su API key como contraseña SMTP (ver [`services/notifications`](services/notifications/README.md)).

Para comprar: el pago se hace en el formulario del adquirente simulado (`webpay-mock`). El resultado
depende del **email del comprador** en el checkout: `@acceptme.com` aprueba, `@rejectme.com` rechaza
(otros dominios se rechazan con `UNSUPPORTED_TEST_EMAIL`). El flujo completo con redirección funciona
por `https://localhost:8443`.

| Servicio local                | Dirección                                        | Credenciales de desarrollo                                                                                      |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| PostgreSQL primaria / réplica | `127.0.0.1:5432` / `:5433`                       | `postgres` / `postgres-dev-password`; una base y un rol por servicio (`<servicio>` / `<servicio>-dev-password`) |
| Redis primario / réplica      | `127.0.0.1:6379` / `:6380`                       | contraseña `redis-dev-password`                                                                                 |
| RabbitMQ (AMQP / consola)     | `127.0.0.1:5672` / http://localhost:15672        | `ticketera` / `rabbitmq-dev-password`                                                                           |
| Mailpit (SMTP / bandeja)      | `127.0.0.1:1025` / http://localhost:8025         | —                                                                                                               |
| Nginx (borde TLS 1.3)         | https://localhost:8443 (`/api/*` → gateway)      | certificado autofirmado                                                                                         |
| API Gateway                   | http://127.0.0.1:3000                            | —                                                                                                               |
| webpay-mock (formulario)      | http://127.0.0.1:3005 · `/webpay/form` vía Nginx | API: `597055555532` / `webpay-mock-dev-secret-0123456789`                                                       |

Se sobrescriben con `infra/.env` (ver `infra/.env.example`).

## Monorepo

| Ruta                     | Contenido                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `src/`                   | Web actual (TanStack Start); se mueve a `apps/web` al terminar la migración (patrón _strangler_)  |
| `packages/commons`       | `@shared/commons`: errores, `ItemVendible`, CLP, logger, BD/outbox, eventos, Redis, servidor HTTP |
| `packages/contracts`     | `@shared/contracts`: OpenAPI y AsyncAPI                                                           |
| `services/template`      | Plantilla de servicio; `npm run new:service -- <nombre>` crea uno nuevo                           |
| `services/identity`      | Cuentas, sesiones (JWT EdDSA + refresh rotativo), roles y API admin de usuarios                   |
| `services/gateway`       | Entrada única: enrutamiento, verificación de JWT, rate limiting, CORS, request-id                 |
| `services/catalog`       | Eventos, recintos, butacas, productos (`ItemVendible`), imágenes y caché de lectura               |
| `services/queue`         | Fila virtual: sala de espera en Redis, admisor con lock de líder, token de admisión               |
| `services/inventory`     | Disponibilidad y reservas de 10 min con bloqueo pesimista (0 % sobreventa)                        |
| `services/orders`        | Carro (Redis), checkout idempotente, órdenes y promociones atómicas; orquesta la saga de compra   |
| `services/payments`      | Intentos de pago, idempotencia, ledger de doble entrada, reembolsos y conciliación                |
| `services/tickets`       | Entradas con QR firmado, historial y check-in atómico                                             |
| `services/notifications` | Correos transaccionales (Python 3.12, SMTP): cuenta, compra, entradas con QR y reembolsos         |
| `apps/scanner`           | App de validación en puerta (https://localhost:8443/scanner/)                                     |
| `services/webpay-mock`   | Adquirente simulado (único mock): API y formulario de Webpay Plus                                 |
| `tools/queue-simulator`  | Bots que hacen fila, reservan y pagan; verifica cupos, órdenes, ledger y 0 sobreventas            |
| `infra/`                 | `docker-compose.yml`, Postgres (réplica síncrona), Nginx                                          |

| Comando                                           | Qué hace                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                               | Web + todos los workspaces                                                                        |
| `npm test`                                        | Tests de todos los workspaces (integración si hay `TEST_*_URL`, ver `packages/commons/README.md`) |
| `npm run lint:backend`                            | ESLint de `packages`, `services`, `tools`, `scripts`                                              |
| `npm run build:backend`                           | Bundle de cada servicio                                                                           |
| `npm run infra:up` / `infra:down` / `infra:reset` | Levanta, detiene o borra la infraestructura local                                                 |
