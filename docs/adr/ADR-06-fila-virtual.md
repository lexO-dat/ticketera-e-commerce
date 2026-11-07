# ADR-06 · Fila virtual con token de admisión

- **Estado:** Aceptado · **ASR:** ASR02 Escalabilidad, ASR03 Consistencia
- Agregado después de la presentación: la fila no figuraba en los diagramas originales.

## Contexto
Al abrir una venta, miles de compradores llegan en segundos. Si todos llegan a reservar a la vez, los
bloqueos pesimistas (ADR-03) generan contención y latencia, y la experiencia se degrada. Además se
necesita un orden justo y frenar bots.

## Decisión
- Servicio `queue` propio sobre **Redis**: ZSET por evento (FIFO), prefila aleatorizada al abrir,
  admisor con lock de líder que admite `concurrent_slots − activos` cada segundo.
- Cada admitido recibe un **token de admisión** JWT (EdDSA) ligado a usuario y evento, con ventana de
  compra configurable. El gateway lo exige para reservar y pagar en eventos con fila; `inventory` y
  `orders` validan que su `jti` siga vigente.
- Operaciones multi-clave con scripts Lua (atómicas). Si Redis falla, la fila se cierra (no se admite sin control).
- Se valida con un simulador de bots (`tools/queue-simulator`).

Detalle: [`docs/services/virtual-queue.md`](../services/virtual-queue.md).

## Consecuencias
- (+) La carga sobre inventario y pagos queda acotada y predecible; orden justo; recargar no pierde el turno.
- (−) El comprador espera; Redis pasa a ser crítico en la ruta de compra (mitigado con réplica y failover).
