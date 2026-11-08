# Roadmap

Arquitectura y reglas: [`AGENTS.md`](AGENTS.md) · [`docs/architecture`](docs/architecture/README.md).

## Prototipo (hecho, sobre Supabase/Lovable)

- [x] Rediseñar el mapa de selección de asientos (layout por sección/fila)
- [x] Bug: la ventana de compra se reiniciaba a 10:00 en cada poll
- [x] Botones pill: menos redondeados, sin punto, texto centrado
- [x] Heroes a sangre completa con texto sobre scrim (home + ficha de evento)
- [x] Cuentas de cliente: registro/login, /mi-cuenta con tickets y eventos pasados
- [x] Compra requiere sesión (comprar, checkout y createOrder validando el token)
- [x] Eliminar dependencias de Lovable
- [x] Parche CVE-2026-102989 (@tanstack/react-start 1.169.4)

## Fase 0 — Arquitectura y documentación

- [x] `AGENTS.md`, vistas 4+1 con la fila virtual, ADR-01..07
- [x] Especificación de pagos y de la fila virtual

## Fase 1 — Monorepo e infraestructura

- [x] Workspaces npm: `packages/`, `services/`, `tools/` (la web sigue en `src/` hasta el corte final)
- [x] `infra/docker-compose.yml`: Postgres primaria + réplica síncrona, Redis + réplica, RabbitMQ, Mailpit, Nginx TLS 1.3
- [x] `@shared/commons` (logger, errores, `ItemVendible`, CLP, BD/outbox/inbox, bus de eventos, locks) y `packages/contracts` (OpenAPI 3.1, AsyncAPI 3)
- [x] Plantilla de servicio (Fastify, health checks, migraciones, outbox, Dockerfile, tests), `npm run new:service` y CI (GitHub Actions)
- [ ] Failover automático de Postgres/Redis (Patroni / Sentinel): se aborda en la Fase 8

## Fase 2 — identity + gateway (reemplaza Supabase Auth y RLS)

- [x] Registro, login, logout, refresh rotativo, verificación de email, recuperación de contraseña, roles
- [x] API admin de usuarios, bootstrap del primer admin, claves EdDSA cifradas con rotación
- [x] Gateway: JWKS, rate limiting (Redis), CORS, request-id, enrutamiento con balanceo entre réplicas
- [x] La web usa identity para autenticarse (BFF con cookies HttpOnly, ADR-08)
- [ ] Correos de verificación y recuperación: los envía `notifications` (Fase 7)

## Fase 3 — catalog

- [x] Eventos, fechas, recintos, sectores, butacas; productos como `ItemVendible` (`POST /v1/items/resolve`)
- [x] Autorización por rol y dueño (organizer: sus eventos; seller: sus productos)
- [x] Media propia (re-codificación a WebP, ADR-09) y caché de lectura en Redis invalidada por generación
- [x] Migración de los datos semilla desde `supabase/migrations` (mismos UUID)
- [x] La web lee y administra el catálogo vía gateway; página de productos en el panel
- [x] Vendidos / disponibilidad en el catálogo público: los aporta `inventory` (Fase 4)
- [x] Configuración de la fila virtual por evento (catalog es su dueño)

## Fase 4 — inventory + queue

- [x] Reservas con bloqueo pesimista, expiración perezosa y barrido (ADR-03)
- [x] Fila virtual con prefila aleatorizada, admisor con lock de líder y token de admisión (ADR-06)
- [x] El gateway pre-verifica el token de admisión; inventory exige `jti` vigente
- [x] `tools/queue-simulator` con verificación de 0 sobreventas (2.000 bots en local, ver su README)
- [x] La web usa la fila y las reservas reales (turno en cookie HttpOnly)
- [ ] `ReservaVendida` y conversión de reserva en venta: con orders (Fase 5)
- [ ] Prueba de 10.000 usuarios en infraestructura dedicada (Fase 8)

## Fase 5 — orders + payments + webpay-mock

- [ ] Carrito, checkout, órdenes, promociones atómicas
- [ ] Intentos de pago, idempotencia, ledger, outbox, reembolsos, conciliación
- [ ] webpay-mock (`@acceptme.com` aprueba, `@rejectme.com` rechaza)

## Fase 6 — tickets + scanner

- [ ] Emisión asíncrona con QR firmado; historial
- [ ] App de validación con check-in atómico

## Fase 7 — notifications (Python)

- [ ] Correos de confirmación, entradas y cuenta vía SMTP propio

## Fase 8 — Corte final

- [ ] La web usa solo el gateway; eliminar `@supabase/supabase-js` y `supabase/`
- [ ] Pruebas de carga (10.000 usuarios) y de failover (≤ 5 s)
