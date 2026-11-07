# ADR-05 · Servicios por dominio + contratos

- **Estado:** Aceptado · **ASR:** ASR05 Modificabilidad

## Contexto
Integrar un nuevo tipo de producto o funcionalidad sin alterar el código base de los servicios.

## Decisión
- Un servicio por dominio (identity, catalog, queue, inventory, orders, payments, tickets,
  notifications) tras un **API Gateway**.
- Cada servicio es dueño de su esquema de BD; nadie lee tablas ajenas.
- Contratos versionados: **OpenAPI** para HTTP y **AsyncAPI** para eventos, en `packages/contracts`.
- Interfaz **`ItemVendible`** (`packages/commons`) como punto de extensión: entradas y productos la
  implementan; `orders` y `payments` solo conocen la interfaz.

## Consecuencias
- (+) Equipos y servicios evolucionan por separado; nuevos tipos de ítem sin tocar el checkout.
- (−) Más interfaces y módulos: mayor complejidad y tiempo de desarrollo inicial; consistencia eventual
  entre servicios (resuelta con outbox + consumidores idempotentes).
