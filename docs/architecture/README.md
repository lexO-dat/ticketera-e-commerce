# Arquitectura — Plataforma de e-commerce y ticketing (modelo 4+1)

Transcripción de la presentación _Arquitectura de Software UDP — Sección 2 — octubre 2026_
(Lucas Abello, Nicolas Gaete, Ariel Jimenez, Cristóbal Oyarce), **extendida con la fila virtual**, que no
estaba en los diagramas originales. Las partes nuevas están marcadas con **🆕 Fila virtual**.

Este documento es la fuente de verdad. Los cambios se hacen con un ADR en [`../adr`](../adr).

---

## 1. Negocio y stakeholders

Plataforma web que vende productos y entradas a eventos, donde organizadores y vendedores administran su
oferta. La demanda llega en picos: miles de personas compiten por la misma entrada al abrir una venta.
Sobrevender o cobrar dos veces destruye la confianza del cliente.

| Meta de calidad | Valor |
| --- | --- |
| Disponibilidad de catálogo y checkout | 99,9 % |
| Usuarios concurrentes en peaks | 10.000 |
| Sobreventa de entradas | 0 % |

| Stakeholder | Concern |
| --- | --- |
| Comprador / usuario | Compra rápida y segura, sin doble cobro; **🆕 fila justa y transparente (posición y espera estimada)** |
| Organizador de eventos | Evitar la sobreventa; ventas actualizadas; **🆕 controlar la tasa de admisión de su venta** |
| Vendedor / comercio | Inventario consistente; órdenes correctas |
| Administrador | Sistema operativo; gestionar incidencias |
| Proveedor de pagos | Operaciones seguras y sin duplicados |
| Personal de acceso | Validar rápido; rechazar entradas usadas |
| Desarrollo y mantenimiento | Cambiar sin afectar otros componentes |
| Arquitecto de software | Trazabilidad entre concerns y decisiones |
| Operación (DevOps / SRE) | Desplegar y recuperarse sin cortes |
| Seguridad (SecOps) | Cifrado, control de acceso y auditoría; **🆕 frenar bots en la fila** |

## 2. Requerimientos funcionales → ASR

| Requerimiento funcional | Valor neg. | Impacto arq. | Por qué sí / por qué no |
| --- | :-: | :-: | --- |
| **RF01 Registro** | M | **A** | Credenciales cifradas en reposo |
| **RF02 Autenticación** | A | **A** | Sesión segura que sobrevive al failover |
| **RF03 Catálogo** | A | **A** | 99,9 % y 10.000 usuarios: réplicas y caché |
| **RF04 Eventos** | A | **A** | Pico de tráfico al abrir cada venta |
| **RF05 Disponibilidad** | A | **A** | Stock en caché; la reserva, siempre en la BD |
| **RF06 Carrito** | A | **A** | Persiste ante fallas; agregar = reservar |
| **RF07 Reserva** | A | **A** | Bloqueo exclusivo 10 min; liberar < 500 ms |
| **RF08 Compra** | A | **A** | Checkout bajo carga y sin sobreventa |
| **RF09 Pago** | A | **A** | TLS 1.3, sin doble cobro; si falla, libera |
| RF10 Generar orden | A | B | Ocurre dentro de la transacción de RF08 |
| RF11 Entrada digital | A | B | Asíncrona tras el pago; tolera segundos |
| RF12 Historial | M | B | Lectura propia, sin métrica de calidad |
| **RF13 Admin. eventos** | M | **A** | Nuevos tipos de evento sin tocar servicios |
| **RF14 Admin. productos** | M | **A** | Nuevos tipos de producto sin tocar servicios |
| RF15 Validar entrada | A | M | Marcado atómico; sin métrica propia |
| **🆕 RF16 Fila virtual** | A | **A** | Absorbe el pico de apertura (ASR02) y protege la reserva (ASR03); justicia y anti-bots |

**RF16 — Fila virtual.** Cuando un evento tiene la fila activa, el sistema deberá ubicar a cada comprador
en una sala de espera ordenada, informarle su posición y espera estimada, y admitir compradores a la
compra a una tasa controlada (cupos concurrentes), entregando a cada admitido una ventana de compra de
duración configurable. Sin admisión válida no se puede reservar ni pagar entradas de ese evento.

## 3. ASR y decisiones (ADR)

| ASR · escenario medible | ADR · decisión | Costo aceptado |
| --- | --- | --- |
| **ASR01 Disponibilidad** — 99,9 % en catálogo y checkout; ante una caída, tráfico a respaldo en ≤ 5 s sin perder sesión ni carrito | **ADR-01 Redundancia sin estado** — contenedores sin estado en 2 zonas tras un balanceador con health checks; PostgreSQL con réplica síncrona y failover automático; sesión y carrito en Redis replicado | Menos simplicidad; más costo de infraestructura y complejidad operativa |
| **ASR02 Escalabilidad** — ≥ 10.000 usuarios concurrentes al abrir ventas, con consulta y compra operativas | **ADR-02 Caché de lectura + autoescalado** — Redis como caché de lectura (TTL de segundos) para catálogo, eventos y stock público; autoescalado horizontal; toda escritura va a la BD | El stock público se muestra con segundos de retraso |
| | **🆕 ADR-06 Fila virtual** — sala de espera en Redis con admisión por cupos y token de admisión firmado; solo los admitidos llegan a reservar | Espera para el comprador; un componente crítico más (Redis) en la ruta de compra |
| **ASR03 Consistencia** — 0 % de sobreventa: reserva exclusiva de 10 min; sin pago, se libera en < 500 ms | **ADR-03 Reserva con bloqueo pesimista** — `SELECT … FOR UPDATE` sobre la entrada y `expiraEn = ahora + 10 min`; una reserva vencida deja de contar al consultarla (expiración perezosa) | Bloqueos estrictos: más latencia y menor rendimiento en los peaks (mitigado por ADR-06) |
| **ASR04 Seguridad** — TLS 1.3 en tránsito; credenciales protegidas en reposo con algoritmos estándar | **ADR-04 Seguridad en capas** — TLS 1.3 de punta a punta; pago tokenizado en el proveedor con clave de idempotencia; OAuth 2.0 / JWT con roles; contraseñas con Argon2id | Cifrar y validar cada transacción agrega carga |
| | **🆕 ADR-07 Adquirente detrás de un adapter** — `PaymentProvider` con implementación `webpay-mock` (decide por dominio del email) | El mock no ejercita la red real de Transbank |
| **ASR05 Modificabilidad** — integrar un nuevo tipo de producto o funcionalidad sin alterar el código base de los servicios | **ADR-05 Servicios por dominio + contratos** — un servicio por dominio tras un API Gateway; contratos OpenAPI / AsyncAPI y eventos; interfaz `ItemVendible` como punto de extensión | Más interfaces y módulos: mayor complejidad y tiempo de desarrollo inicial |

---

## Vista de escenarios (+1)

Casos de uso significativos. Los marcados con ★ ejercen un ASR.

```mermaid
flowchart LR
  C([Comprador / Usuario])
  PA([Personal de acceso])
  O([Organizador])
  V([Vendedor])
  A([Administrador])
  PP([Proveedor de pagos<br/>«externo»])

  subgraph Plataforma de e-commerce y ticketing
    UC1(["★ Consultar eventos y disponibilidad<br/>RF04 · RF05"])
    UCQ(["★ 🆕 Esperar en fila virtual<br/>RF16"])
    UC2(["★ Comprar entrada<br/>RF08"])
    UC3(["★ Reservar entrada 10 min<br/>RF07"])
    UC4(["★ Procesar pago<br/>RF09"])
    UC5(["Emitir entrada digital<br/>RF11"])
    UC6(["Generar orden<br/>RF10"])
    UC7(["Validar entrada<br/>RF15"])
    UC8(["★ Administrar eventos y productos<br/>RF13 · RF14"])
    UCQA(["🆕 Configurar fila del evento<br/>RF16"])
  end

  C --> UC1
  C --> UCQ
  C --> UC2
  UCQ -. «precede» .-> UC2
  UC2 -. «include» .-> UC3
  UC2 -. «include» .-> UC4
  UC2 -. «include» .-> UC6
  UC6 -. «extend» .-> UC5
  UC4 --> PP
  PA --> UC7
  O --> UC8
  O --> UCQA
  V --> UC8
  A --> UC8
  A --> UCQA
```

## Vista lógica

Dominios que ve el frontend y sus entidades principales.

```mermaid
flowchart TB
  FE["Frontend (Web / App)"]
  FE --> CAT[Catálogo]
  FE --> FILA["🆕 Fila virtual"]
  FE --> CAR[Carrito]
  FE --> ENT[Entradas]
  FE --> PAG[Pagos]
  FE --> USR[Usuarios]

  CAT -.-> EV[Eventos]
  CAT -.-> PROD["ItemVendible<br/>(entrada · producto)"]
  FILA -.-> TQ["🆕 TurnoFila"]
  FILA -.-> AD["🆕 Admisión"]
  CAR -.-> IC[Ítem carrito]
  CAR -.-> RES[Reserva]
  ENT -.-> EN[Entrada]
  ENT -.-> OR[Orden]
  PAG -.-> TR[Transacción]
  USR -.-> CL[Cliente]
  USR -.-> AM[Administrador]
```

Modelo de clases (núcleo):

```mermaid
classDiagram
  class ItemVendible {
    <<interface>>
    +id: UUID
    +tipo: string
    +precio(): CLP
    +disponibilidad(): number
    +reservar(cantidad, ttl): Reserva
  }
  class Evento { slug; titulo; categoria; estado }
  class FechaEvento { inicio; recinto; enVenta }
  class TipoEntrada { nombre; precio; cargo; capacidad }
  class Butaca { fila; numero; bloqueada }
  class Producto { sku; nombre; precio; stock }
  class Reserva { estado: ACTIVA|VENDIDA|LIBERADA|VENCIDA; expiraEn }
  class ConfigFila { habilitada; cuposConcurrentes; ventanaMin; abreEn }
  class TurnoFila { numeroLlegada; estado: ESPERANDO|ADMITIDO|VENCIDO|COMPLETADO }
  class Admision { jti; expiraEn }
  class Orden { codigo; estado; subtotal; cargos; descuento; total }
  class ItemOrden { cantidad; precioUnitario; cargoUnitario }
  class IntentoPago { estado; monto; claveIdempotencia }
  class Transaccion { tokenAdquirente; codigoAutorizacion; codigoRespuesta }
  class Entrada { codigo; qrFirmado; usadaEn }
  class Usuario { email; hashArgon2id; roles }

  ItemVendible <|.. TipoEntrada
  ItemVendible <|.. Producto
  Evento "1" --> "*" FechaEvento
  FechaEvento "1" --> "*" TipoEntrada
  TipoEntrada "1" --> "*" Butaca : sector numerado
  Evento "1" --> "0..1" ConfigFila
  ConfigFila "1" --> "*" TurnoFila
  TurnoFila "1" --> "0..1" Admision
  Usuario "1" --> "*" TurnoFila
  Usuario "1" --> "*" Reserva
  Reserva "*" --> "1" ItemVendible
  Usuario "1" --> "*" Orden
  Orden "1" --> "*" ItemOrden
  Orden "1" --> "*" IntentoPago
  IntentoPago "1" --> "*" Transaccion
  ItemOrden "1" --> "*" Entrada
```

## Vista de procesos

Secuencia de compra. La parte 🆕 (fila virtual) precede a la secuencia original de la presentación.

```mermaid
sequenceDiagram
  actor C as Comprador
  participant GW as API Gateway
  participant Q as 🆕 Fila virtual
  participant INV as Inventario y reservas
  participant ORD as Carrito y órdenes
  participant PAY as Pagos
  participant PP as Proveedor de pagos («externo», mock)
  participant TIX as Entradas
  participant MQ as Broker

  rect rgb(240, 235, 255)
  Note over C,Q: 🆕 Fila virtual (si el evento la tiene activa)
  C->>GW: Entrar a la fila (evento)
  GW->>Q: join(usuario, evento)
  Q-->>C: turno n°, posición, ETA, Retry-After
  loop Hasta ser admitido (backoff indicado por el servidor)
    C->>GW: estado de la fila
    GW->>Q: status(turno)
    Q-->>C: posición / ETA
  end
  Note over Q: Admisor (líder): cada 1 s admite<br/>cupos libres = cupos − activos
  Q-->>C: ADMITIDO + token de admisión (JWT, ventana N min)
  end

  C->>GW: 1. Agregar entrada (RF06 · RF07) + token de admisión
  GW->>GW: verifica JWT de usuario y token de admisión
  GW->>INV: reservar(butaca/tipo)
  INV->>INV: SELECT … FOR UPDATE · expiraEn = ahora + 10 min
  INV-->>C: 2. Reserva exclusiva
  C->>GW: 3. Confirmar compra (RF08)
  GW->>ORD: checkout (montos calculados en servidor)
  ORD->>PAY: 4. Cobrar con clave de idempotencia (RF09)
  PAY->>PP: 5. Autorizar (TLS 1.3)
  alt pago aprobado antes del vencimiento
    PP-->>PAY: aprobado
    PAY-->>ORD: pago OK (evento PagoProcesado)
    ORD->>ORD: 6. Generar orden (RF10)
    ORD->>INV: 7. Reserva → VENDIDA
    ORD->>MQ: 8. OrdenConfirmada (asíncrono · RF11)
    MQ-->>TIX: emitir entradas (QR firmado)
    ORD->>Q: 🆕 liberar cupo (turno COMPLETADO)
    ORD-->>C: orden confirmada
  else pago rechazado o reserva vencida
    ORD->>INV: liberar (< 500 ms)
    ORD-->>C: compra no completada
    Note over PAY: si el pago se aprobó con la reserva vencida → reembolso automático
  end
```

Ciclo de vida de un turno de la fila:

```mermaid
stateDiagram-v2
  [*] --> PREFILA: llega antes de abrir la venta
  [*] --> ESPERANDO: llega con la venta abierta
  PREFILA --> ESPERANDO: apertura (orden aleatorio entre los de la prefila)
  ESPERANDO --> ADMITIDO: admisor asigna cupo (token emitido)
  ESPERANDO --> ABANDONADO: sin heartbeat > umbral
  ADMITIDO --> COMPLETADO: orden confirmada
  ADMITIDO --> VENCIDO: termina la ventana de compra
  COMPLETADO --> [*]
  VENCIDO --> [*]
  ABANDONADO --> [*]
```

## Vista de desarrollo

Componentes del código y sus dependencias.

```mermaid
flowchart TB
  subgraph P["1. Presentación"]
    WEB["Web comprador + admin<br/>React (TanStack Start)<br/>apps/web"]
    SCAN["App validación<br/>React · apps/scanner"]
  end

  subgraph B["2. Microservicios / Backend"]
    GW["API Gateway · Node/TS<br/>services/gateway"]
    ID["Identity · Node/TS<br/>Controller / Service / Repository"]
    CAT["Catálogo · Node/TS<br/>Controller / Service / Model"]
    Q["🆕 Fila virtual · Node/TS<br/>Controller / Admisor / Repository"]
    INV["Inventario · Node/TS<br/>Controller / Service / Repository"]
    ORD["Órdenes · Node/TS<br/>Controller / Service / Repository / Publisher"]
    PAY["Pagos · Node/TS<br/>Controller / Service / Provider adapter / Publisher"]
    WPM["webpay-mock · Node/TS<br/>(único mock)"]
    TIX["Entradas · Node/TS<br/>Consumer / Service"]
    NOTI["Notificaciones · Python<br/>Consumer / Mailer / Plantillas HTML"]
  end

  subgraph D["3. Datos y mensajería"]
    RD[("Redis<br/>caché · sesión · carrito · 🆕 fila")]
    PG[("PostgreSQL<br/>primaria / réplica")]
    MQ{{"RabbitMQ<br/>eventos"}}
  end

  subgraph L["4. Librerías compartidas"]
    COM["@shared/commons<br/>tipos, ItemVendible, logger, errores"]
    CON["contracts<br/>OpenAPI / AsyncAPI"]
  end

  subgraph T["5. Herramientas"]
    SIM["🆕 queue-simulator<br/>bots / carga"]
  end

  WEB -->|HTTPS| GW
  SCAN -->|HTTPS| GW
  SIM -->|HTTPS| GW
  GW -->|/auth| ID
  GW -->|/catalog| CAT
  GW -->|/queue| Q
  GW -->|/inventory| INV
  GW -->|/checkout, /orders| ORD
  GW -->|/payments| PAY
  GW -->|/tickets| TIX
  PAY -->|adapter| WPM

  CAT -->|caché| RD
  Q -->|ZSET / admisión| RD
  GW -->|rate limit · jti| RD
  ID & CAT & INV & ORD & PAY & TIX --> PG
  ORD -->|OrdenConfirmada| MQ
  PAY -->|PagoProcesado| MQ
  Q -->|TurnoAdmitido| MQ
  MQ -->|consumo| TIX
  MQ -->|consumo| NOTI
  MQ -->|consumo| ORD

  B -.->|tipos / logger| COM
  B -.->|contratos| CON
```

## Vista física

```mermaid
flowchart TB
  DEV["Dispositivo · navegador / móvil"] -->|HTTPS| CDN["CDN + WAF · TLS 1.3<br/>(propio: Nginx/Envoy + reglas WAF)"]
  CDN --> LB["Balanceador de carga · health checks"]

  subgraph APP["Capa de aplicación · sin estado · autoescalada"]
    ZA["Contenedores Zona A<br/>gateway · servicios · 🆕 queue (admisor con lock de líder)"]
    ZB["Contenedores Zona B<br/>gateway · servicios · 🆕 queue"]
  end
  LB --> ZA
  LB --> ZB
  ZA & ZB <--> MQ{{"Broker de mensajes<br/>RabbitMQ (cluster 2 zonas, colas quorum)"}}
  ZA & ZB -->|TLS 1.3| PP(("Proveedor de pagos<br/>webpay-mock"))

  subgraph DATA["Capa de datos · 2 zonas de disponibilidad"]
    PGA[("PostgreSQL primaria<br/>Zona A")] -->|replicación síncrona| PGB[("PostgreSQL réplica<br/>Zona B")]
    RDA[("Redis primario<br/>Zona A")] -->|replicación| RDB[("Redis réplica<br/>Zona B")]
  end
  ZA & ZB --> PGA
  ZA & ZB --> RDA
```

Notas de despliegue:

- En local todo corre con `infra/docker-compose.yml` (Postgres primaria + réplica, Redis + réplica,
  RabbitMQ, Mailpit como SMTP, Nginx con TLS 1.3 haciendo de balanceador).
- Failover de Postgres y Redis: Patroni / Sentinel (o equivalente) en producción; los servicios usan
  _connection strings_ que apuntan al líder vigente.
- La fila depende de Redis: si Redis cae, la fila se **cierra** (los nuevos esperan con reintento) en vez
  de admitir sin control. Prefiere disponibilidad parcial a sobreventa.

## Trazabilidad

| Concern | Stakeholder | ASR | ADR |
| --- | --- | --- | --- |
| Evitar interrupciones durante una venta | Comprador / Administrador | ASR01 | ADR-01 |
| Soportar alta cantidad de compradores | Comprador / Organizador | ASR02 | ADR-02, ADR-06 |
| Fila justa, sin bots | Comprador / Organizador / SecOps | ASR02, ASR04 | ADR-06 |
| Evitar venta duplicada de una entrada | Organizador / Comprador | ASR03 | ADR-03 |
| Proteger las transacciones, sin doble cobro | Comprador / Proveedor de pagos | ASR04 | ADR-04, ADR-07 |
| Permitir evolución de la plataforma | Desarrollo / Vendedores / Organizadores | ASR05 | ADR-05 |
