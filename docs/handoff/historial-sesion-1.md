# Traspaso de contexto — Sesión 1 (6–7 nov 2026)

Documento para que un agente nuevo entienda **todo lo que se habló y se hizo** en la primera sesión de
trabajo sobre este repositorio, sin tener que leer el chat original. Léelo junto con
[`AGENTS.md`](../../AGENTS.md), que es la guía vigente y manda sobre este archivo si discrepan.

---

## 0. Resumen en 10 líneas

1. El repo es un prototipo de ticketera generado con **Lovable** sobre **Supabase** (TanStack Start + React).
2. Se hizo un análisis completo: la UI está bastante completa, pero **pagos, correos, QR, check-in y la
   fila virtual no existen o son simulados**, y todo el backend depende de Supabase.
3. Se **eliminaron todas las dependencias de Lovable** (commit `400e3fe`).
4. Se **parchó la CVE-2026-102989** subiendo `@tanstack/react-start` a 1.169.4 (commit `ac433fa`).
5. El usuario entregó la **arquitectura oficial** (presentación 4+1 del curso, PDF) como fuente de verdad.
6. Se creó `AGENTS.md`, `docs/architecture` (4+1 en Mermaid **con la fila virtual agregada**),
   7 ADR y especificaciones de **pagos** y **fila virtual** (commit `da8c44b`).
7. Objetivo del proyecto: **reemplazar todo servicio externo por microservicios propios**. Única excepción:
   el adquirente Webpay, que será un **mock** (`@acceptme.com` aprueba, `@rejectme.com` rechaza).
8. Nada de los microservicios está implementado todavía. **Próximo paso: Fase 1** (monorepo + infra).
9. Todo está en la rama `claude/bold-edison-81sxtx`; **`main` sigue en el commit inicial** (no hay PR).
10. Reglas del usuario para commits: **una línea, sin cuerpo, sin Co-Authored-By, sin mencionar IA**.

---

## 1. Personas y contexto

- Usuario: **Lucas Abello** (`lucas.abello@mail.udp.cl`), integrante del equipo. Escribe en español.
- Equipo (curso _Arquitectura de Software_, UDP, Sección 2, prof. Eduardo Reveco): Lucas Abello,
  Nicolas Gaete, Ariel Jimenez, Cristóbal Oyarce.
- Repositorio: `lexO-dat/ticketera-e-commerce`. Rama de trabajo: `claude/bold-edison-81sxtx`.
- Documentos del curso en Google Drive del usuario:
  - _Primer Informe Proyecto Arquitectura_ (Google Doc): stakeholders, RF01–RF15, ASR01–ASR05.
  - _Presentacion_Arquitectura_4_1_ (PDF/Slides): **la fuente de verdad**; ya transcrita en
    `docs/architecture/README.md`.

## 2. Preferencias y reglas del usuario (respetarlas siempre)

- **Commits**: una sola línea, Conventional Commits, **sin body, sin `Co-Authored-By`, sin mencionar
  Claude ni herramientas de IA**.
- **Autor de los commits**: el usuario pidió que figure **su correo**. Está configurado en el repo local:
  `git config user.name "Lucas Abello"` / `user.email "lucas.abello@mail.udp.cl"`.
- Respuestas y documentación en **español**; identificadores de código en inglés.
- No crear pull requests sin que lo pida.
- Quiere todo **construido desde cero** con librerías open source, pensando en seguridad, mantenimiento
  y escalabilidad; **sin proveedores gestionados** (Supabase, Auth0, Stripe, SendGrid, etc.).

## 3. Cronología

### 3.1 Análisis inicial del repo («¿qué le falta?»)

Estado encontrado (commit inicial `f9534fc`):

- Stack: TanStack Start (React 19, SSR) + Tailwind/shadcn + `@supabase/supabase-js`. Build con
  `@lovable.dev/vite-tanstack-config` (Nitro con preset Cloudflare por defecto).
- UI completa: home, cartelera, ficha de evento, mapa de butacas, fila virtual, carro, checkout,
  mi cuenta, órdenes, admin (eventos, recintos, órdenes, promociones, equipo).
- Backend: server functions en `src/lib/*.functions.ts` que llaman a Supabase (PostgREST).
- Esquema en `supabase/migrations/` (eventos, fechas, recintos, sectores, butacas, tipos de entrada,
  seat_holds, órdenes, ítems, tickets, queue_config/queue_sessions, promo_codes, métricas, newsletter)
  con RLS y FKs a `auth.users`.

Dependencias de terceros detectadas: Supabase (BD, Auth, RLS, `auth.admin`), CDN de assets de Lovable,
build/deploy de Lovable (Cloudflare), telemetría de Lovable. `cron-auth.ts` existía pero no se usaba.

Funcionalidad **simulada o inexistente**:
- **Pagos**: `createOrder` inserta la orden con `status: "paid"`; el formulario de tarjeta viene precargado
  con `4111…` y no se envía a ningún lado. Reembolsos solo cambian un estado.
- **Fila virtual**: posición con `Math.random`, avance por tiempo (`DRAIN_SECONDS = 45`);
  `concurrent_slots` nunca se usa; se puede saltar llamando la server function directamente.
- **Correos**: no se envía ninguno (la UI dice que sí). Contacto no envía nada. Newsletter solo guarda.
- **QR / check-in**: no hay QR ni app de validación; `ticket_code` con `Math.random`.
- No hay subida de imágenes, `profiles` no se llena (el trigger nunca se creó), no hay jobs de limpieza,
  README vacío, sin tests ni CI.

Bugs y riesgos detectados (a corregir al reescribir; **no** se corrigieron en el prototipo):
1. `adminDb()` usa `SUPABASE_PUBLISHABLE_KEY`, no una service-role key: con la RLS actual, las escrituras
   de checkout y `auth.admin.*` probablemente fallan (no se probó contra el proyecto real).
2. `createOrder` no verifica que el asiento esté retenido por esa sesión, ni capacidad, ni coherencia
   tipo/fecha/asiento.
3. Sin transacciones: orden, ítems, tickets, `sold++` y `used_count++` en llamadas separadas
   (leer-modificar-escribir) → sobreventa y abuso de promociones posibles.
4. `getOrder` es público: con el código `TK…` se ven nombre, email y tickets.
5. `holdSeats`/`releaseSeats` anónimos con cualquier `sessionToken`; `releaseSeats` libera todas las fechas.
6. `trackMetric` público sin rate limiting.
7. Sin validación de RUT ni boleta/factura (SII).

### 3.2 Eliminar Lovable — commit `400e3fe` (`chore: remove all Lovable dependencies`)

- `vite.config.ts`: config explícita (tailwind, tsconfig paths, TanStack Start con `server.entry: "server"`
  e `importProtection`, React, **Nitro con preset `node-server`** sobreescribible con `NITRO_PRESET`).
- `server.host: true` (el `"::"` heredado fallaba en entornos sin IPv6).
- Plugin propio solo-dev `devKeepAliveOnRejection`: registra `unhandledRejection` para que un error de
  server function no mate el dev server (antes lo hacía el paquete de Lovable).
- Se eliminó `src/lib/lovable-error-reporting.ts`, los `src/assets/events/*.asset.json` (punteros al CDN
  de Lovable; las imágenes nunca estuvieron en el repo), y los metadatos «Lovable App» (ahora «Ticketera»,
  `lang="es"`).
- `bun.lock` apuntaba al caché npm privado de Lovable → se reemplazó por el registro público.
- Verificado: build, tsc, lint de lo tocado, SSR 200 en prod (Node) y dev.
- Nota: este commit quedó con autor **Claude** en GitHub (ver §6).

### 3.3 Despliegue fallido por CVE — commit `ac433fa`

El despliegue de la rama falló: `@tanstack/react-start@1.168.32` tiene la **CVE-2026-102989** (XSS).
- Se subió a `@tanstack/react-start@1.169.4`, `@tanstack/react-router@1.170.46`,
  `@tanstack/router-plugin@1.168.48` (versiones exactas).
- Cambio de API: `createServerFn().inputValidator()` fue eliminado → renombrado a **`.validator()`** en
  las 27 server functions (sin esto todo daba 500).
- `errorComponent` ahora recibe `error: unknown` → ajustados 5 archivos (`error instanceof Error ? … : String(error)`).
- Verificado: tsc, build, 200 en `/`, `/eventos`, `/ayuda`, `/auth`, `/checkout`, `/admin` (prod y dev).
- Pregunta del usuario: **«¿por qué no está en main?»** → porque todo se trabajó en la rama de la sesión y
  no se abrió PR; `main` sigue vulnerable y con Lovable. Se ofreció abrir el PR (pendiente de respuesta).

### 3.4 Arquitectura y guía — commit `da8c44b`

El usuario pidió: tomar la presentación 4+1 como **fuente de verdad**, **agregar la fila virtual a los
diagramas** (faltaba), y crear un `agent.md` con directrices. Objetivo declarado: **crear microservicios
propios para todo lo que hoy hacen servicios externos**, desde cero; solo la llamada al adquirente
(Webpay) puede ser mock, decidiendo por el email (`@acceptme.com` pasa, `@rejectme.com` no); la fila
virtual debe ser real y probarse con bots / simulador de carga.

Archivos creados:
- `AGENTS.md` (guía principal) y `CLAUDE.md` (solo `@AGENTS.md`).
- `docs/architecture/README.md`: negocio, stakeholders, RF→ASR (se agregó **RF16 Fila virtual**),
  ASR↔ADR, y las vistas en Mermaid: escenarios, lógica (+ diagrama de clases con `ItemVendible`),
  procesos (secuencia de compra **precedida por la fila**, estados del turno), desarrollo y física.
  Los 9 diagramas se compilaron con mermaid-cli para verificar.
- `docs/adr/ADR-01..07` (+ índice). ADR-01..05 vienen de la presentación; **ADR-06 Fila virtual** y
  **ADR-07 Adquirente mock** son nuevos.
- `docs/services/payments.md`: investigación y especificación del servicio de pagos.
- `docs/services/virtual-queue.md`: diseño de la fila y del simulador.
- `roadmap.md` (fases 0–8) y `README.md`.

## 4. La arquitectura en breve (detalle en `docs/architecture`)

Metas: **99,9 %** disponibilidad de catálogo y checkout (failover ≤ 5 s sin perder sesión ni carrito),
**≥ 10.000** usuarios concurrentes, **0 %** sobreventa (reserva exclusiva 10 min, liberación < 500 ms),
TLS 1.3 + Argon2id + pago tokenizado e idempotente, modificabilidad vía `ItemVendible`.

| ADR | Decisión |
| --- | --- |
| 01 | Contenedores sin estado en 2 zonas tras balanceador; Postgres réplica síncrona + failover; sesión/carrito en Redis replicado |
| 02 | Redis como caché de lectura (TTL segundos) para catálogo/eventos/stock público; autoescalado; escrituras a la BD |
| 03 | Reserva con `SELECT … FOR UPDATE` y `expiraEn = ahora + 10 min`; expiración perezosa |
| 04 | TLS 1.3; pago tokenizado con clave de idempotencia; OAuth 2.0/JWT con roles; Argon2id |
| 05 | Un servicio por dominio tras API Gateway; contratos OpenAPI/AsyncAPI; `ItemVendible` |
| 06 🆕 | Fila virtual en Redis (ZSET, admisor con lock de líder, token de admisión JWT EdDSA ligado a usuario+evento) |
| 07 🆕 | Adquirente detrás de `PaymentProvider`; `webpay-mock` decide por dominio del email |

Servicios: `gateway`, `identity`, `catalog`, `queue`, `inventory`, `orders`, `payments`, `webpay-mock`,
`tickets`, `notifications` (Python), librería `@shared/commons`, `packages/contracts`, apps `web` y
`scanner`, herramienta `tools/queue-simulator`. Datos: PostgreSQL, Redis, RabbitMQ.

Puntos clave decididos en la sesión:
- **Webpay mock**: imita la API real de Webpay Plus (create → redirect → commit → status → refund, y los
  retornos `token_ws` / `TBK_TOKEN` / timeout). `@acceptme.com` → AUTHORIZED; `@rejectme.com` → FAILED;
  **otro dominio → rechazado** con `UNSUPPORTED_TEST_EMAIL` (decisión del agente, configurable con
  `WEBPAY_MOCK_DEFAULT_OUTCOME`). El email llega al mock en el header de extensión `X-Mock-Payer-Email`.
- **Pagos**: máquina de estados (CREATED, PENDING, AUTHORIZED, FAILED, CANCELED, EXPIRED, UNKNOWN,
  REFUND_PENDING, REFUNDED, PARTIALLY_REFUNDED), `Idempotency-Key` obligatoria, montos desde `orders`,
  CLP en `bigint`, ledger de doble entrada append-only, outbox, conciliación por `status`, reembolso
  automático si el pago llega con la reserva vencida, sin datos de tarjeta.
- **Fila**: prefila aleatorizada al abrir, FIFO, `concurrent_slots`, ventana de compra, `Retry-After`,
  recargar no pierde el turno, si Redis cae la fila se cierra (nunca admitir sin control). El simulador
  lanza miles de bots (mezcla acceptme/rejectme) y **verifica 0 sobreventas** y latencias p50/p95/p99.

## 5. Decisiones abiertas (esperan confirmación del equipo)

1. **Frontend**: la presentación dice React/Next.js; el prototipo es TanStack Start. Propuesta: mantener
   TanStack Start (si se cambia, ADR nuevo).
2. **Broker**: presentación dice «RabbitMQ / Kafka». Propuesta: **RabbitMQ**.
3. **Productos e-commerce** (RF03, RF14): no existen en el prototipo; se modelarán como `ItemVendible` en `catalog`.

## 6. Estado de git y pendientes operativos

```
da8c44b Lucas Abello | docs: add AGENTS.md, 4+1 architecture with virtual queue, ADRs and service specs
ac433fa Lucas Abello | fix: upgrade @tanstack/react-start to 1.169.4 to patch CVE-2026-102989
400e3fe Claude       | chore: remove all Lovable dependencies
f9534fc LexO-dat     | feat: Initial commit for the e-commerce   ← origin/main
```

- Rama `claude/bold-edison-81sxtx` sincronizada con GitHub. **`main` no tiene ninguno de estos cambios.**
- **Autoría de `400e3fe`**: figura como Claude. El usuario pidió su correo; reescribirlo requiere
  `git push --force-with-lease`, que fue **bloqueado** por el clasificador de permisos de la sesión. Hay una
  copia local con el autor corregido en la rama `backup/lucas-author` (mismo contenido). Pendiente de que
  el usuario decida/autorice.
- Un hook del entorno pide que los commits usen la identidad `Claude <noreply@anthropic.com>` para que
  GitHub los marque como _Verified_. **Contradice la instrucción del usuario**; se le explicó y prevalece
  lo que pidió el usuario (su correo, commits quedan «Unverified»). No cambiar la identidad sin preguntarle.
- Push: al inicio GitHub devolvía 403 (la app de Claude no tenía acceso); el usuario lo arregló.
- Ofrecido y **sin respuesta**: abrir PR de la rama hacia `main`.

## 7. Entorno técnico (útil para el próximo agente)

- Node 22, npm y bun disponibles; hay `package-lock.json` y `bun.lock` (ambos mantenidos).
- Comandos: `npm run build`, `npx tsc --noEmit`, `npx eslint <archivos>` (hay errores de prettier
  preexistentes en archivos generados de Supabase; formatea solo lo que tocas), `npm run dev`.
- Probar SSR sin Supabase real: `SUPABASE_URL=http://127.0.0.1:1 SUPABASE_PUBLISHABLE_KEY=x` (+ las
  `VITE_*` en dev). Las páginas responden 200; los errores de `fetch failed` son esperables.
- Producción: `node .output/server/index.mjs` (con `PORT`).
- Aviso de Vite: `vite-tsconfig-paths` podría reemplazarse por `resolve.tsconfigPaths: true` (no urgente).

## 8. Próximo paso

**Fase 1** del `roadmap.md`: monorepo (`apps/`, `services/`, `packages/`, `tools/`, `infra/`),
`infra/docker-compose.yml` (Postgres primaria + réplica, Redis + réplica, RabbitMQ, Mailpit, Nginx con
TLS 1.3), `@shared/commons`, `packages/contracts`, plantilla de servicio (Fastify, health checks,
migraciones, Dockerfile, tests con Vitest) y CI. Luego Fase 2 (`identity` + `gateway`).
