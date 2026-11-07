# ADR-02 · Caché de lectura + autoescalado

- **Estado:** Aceptado · **ASR:** ASR02 Escalabilidad

## Contexto
≥ 10.000 usuarios concurrentes al abrir ventas, con consulta y compra operativas.

## Decisión
- Redis como **caché de lectura** (TTL de segundos) para catálogo, eventos y stock público.
- Autoescalado horizontal de los servicios sin estado.
- **Toda escritura va a la BD** (primaria). La disponibilidad real se decide siempre en `inventory`, nunca en la caché.

## Consecuencias
- (+) Las lecturas masivas no golpean Postgres.
- (−) El stock público se muestra con segundos de retraso (puede decir "disponible" y fallar al reservar; la UI debe manejarlo).
- Invalidación: los servicios publican eventos de cambio y la caché también expira por TTL.
