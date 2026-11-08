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
- [x] Failover automático de Postgres/Redis: hecho en la Fase 8 (ADR-10)

## Fase 2 — identity + gateway (reemplaza Supabase Auth y RLS)

- [x] Registro, login, logout, refresh rotativo, verificación de email, recuperación de contraseña, roles
- [x] API admin de usuarios, bootstrap del primer admin, claves EdDSA cifradas con rotación
- [x] Gateway: JWKS, rate limiting (Redis), CORS, request-id, enrutamiento con balanceo entre réplicas
- [x] La web usa identity para autenticarse (BFF con cookies HttpOnly, ADR-08)
- [x] Correos de verificación y recuperación: los envía `notifications` (Fase 7)

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
- [x] `ReservaVendida` y conversión de reserva en venta: con orders (Fase 5)
- [x] Prueba de 10.000 usuarios: en la Fase 8 (local); la versión en infraestructura dedicada está en `todo.md`

## Fase 5 — orders + payments + webpay-mock

- [x] Carrito en Redis, checkout idempotente, órdenes y promociones atómicas
- [x] Intentos de pago, idempotencia, ledger append-only, outbox, reembolsos (admin y automático por pago tardío), conciliación
- [x] webpay-mock (`@acceptme.com` aprueba, `@rejectme.com` rechaza), con formulario y modos de falla
- [x] Autenticación entre servicios (`/internal/*` con secreto compartido; el gateway no los enruta)
- [x] La web compra de verdad: carro del servidor, checkout → Webpay → orden; panel con reembolsos y promociones
- [x] El simulador paga por Webpay y verifica órdenes, ledger y 0 sobreventas

## Fase 6 — tickets + scanner

- [x] Emisión asíncrona (al confirmarse la orden) con QR firmado EdDSA; historial en la orden y en Mi cuenta
- [x] App de validación (`apps/scanner`, cámara o código) con check-in atómico y auditoría de cada escaneo
- [x] Un reembolso anula las entradas no usadas; una orden con entradas ya validadas no se reembolsa

## Fase 7 — notifications (Python)

- [x] Servicio Python 3.12 (aio-pika, aiosmtplib, Jinja2) con la misma topología de colas, reintentos y DLQ que commons
- [x] Correos de cuenta (verificación, recuperación), compra confirmada, entradas con QR embebido y cancelación/reembolso
- [x] Un correo por evento (dedupe en Redis, `Message-ID` = id del evento); fallas permanentes a la DLQ
- [x] SMTP estándar: Mailpit en desarrollo; proveedor real solo con variables (API key como contraseña SMTP)

## Fase 8 — Corte final

- [x] La web usa solo el gateway; eliminados `@supabase/supabase-js`, `src/integrations/supabase` y `supabase/`
- [x] Embudo de ventas y newsletter en `catalog` (vistas en lote desde Redis; reservas, checkouts y compras por eventos)
- [x] Prueba de carga: 10.000 usuarios concurrentes en la fila, 0 errores, 0 sobreventas, ledger balanceado
- [x] Failover automático (ADR-10): monitor propio de PostgreSQL con aislamiento de la primaria vieja,
      Redis Sentinel, gateway ×2 tras Nginx; `npm run test:failover` mide ≤ 5 s en todos los escenarios
- [x] Encontrado al medir: una entrada sin reserva se podía comprar (ahora `requiresReservation` del
      `ItemVendible`), una orden solo de productos no se confirmaba y un rechazo definitivo de inventory
      dejaba el cobro retenido (ahora se reembolsa)
- [x] Tienda de productos en la web (`/tienda`) con carro mixto (entradas + productos)
- [x] La web se movió a `apps/web` (workspace `@apps/web`); se quitaron los restos de Lovable (`bun.lock`)
- Pendientes de infraestructura fuera del alcance local: ver [`todo.md`](todo.md)
