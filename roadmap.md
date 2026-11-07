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

- [ ] Workspaces: `apps/`, `services/`, `packages/`, `tools/`, `infra/`
- [ ] `infra/docker-compose.yml`: Postgres primaria+réplica, Redis+réplica, RabbitMQ, Mailpit, Nginx TLS 1.3
- [ ] `@shared/commons` (logger, errores, `ItemVendible`, cliente de eventos, outbox) y `packages/contracts`
- [ ] Plantilla de servicio (Fastify, health checks, migraciones, Dockerfile, tests) y CI

## Fase 2 — identity + gateway (reemplaza Supabase Auth y RLS)

- [ ] Registro, login, logout, refresh rotativo, verificación de email, recuperación de contraseña, roles
- [ ] Gateway: JWKS, rate limiting, CORS/CSRF, request-id, enrutamiento
- [ ] La web usa identity para autenticarse

## Fase 3 — catalog

- [ ] Eventos, fechas, recintos, sectores, butacas; productos como `ItemVendible`
- [ ] Media propia (subida de imágenes) y caché de lectura
- [ ] Migración de los datos semilla desde `supabase/migrations`

## Fase 4 — inventory + queue

- [ ] Reservas con bloqueo pesimista y expiración perezosa (ADR-03)
- [ ] Fila virtual con admisor y token de admisión (ADR-06)
- [ ] `tools/queue-simulator` con verificación de 0 sobreventas

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
