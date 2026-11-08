-- Inventario y reservas (ADR-03). La capacidad publicada es de catalog (proyección local, se
-- actualiza con EventoActualizado); vendidos y reservados son de este servicio.

create table event_projection (
  event_id uuid primary key,
  status text not null,
  queue_enabled boolean not null default false,
  -- Orden de los eventos de catalog: se ignora un EventoActualizado más viejo que el aplicado.
  source_occurred_at timestamptz not null,
  synced_at timestamptz not null default now()
);

create table ticket_inventory (
  ticket_type_id uuid primary key,
  event_id uuid not null references event_projection (event_id) on delete cascade,
  event_date_id uuid not null,
  section_id uuid not null,
  seated boolean not null,
  capacity integer not null check (capacity >= 0),
  on_sale boolean not null,
  starts_at timestamptz not null,
  -- false si catalog quitó el tipo de entrada: deja de venderse, sus ventas se conservan.
  active boolean not null default true,
  -- Contadores bajo bloqueo de fila (SELECT … FOR UPDATE): nunca leer-modificar-escribir en la app.
  reserved integer not null default 0 check (reserved >= 0),
  sold integer not null default 0 check (sold >= 0),
  updated_at timestamptz not null default now()
);
create index ticket_inventory_event_idx on ticket_inventory (event_id);
create index ticket_inventory_date_idx on ticket_inventory (event_date_id);

create table reservations (
  id uuid primary key,
  user_id uuid not null,
  event_id uuid not null,
  event_date_id uuid not null,
  ticket_type_id uuid not null references ticket_inventory (ticket_type_id),
  quantity integer not null check (quantity > 0),
  status text not null check (status in ('ACTIVE', 'SOLD', 'RELEASED', 'EXPIRED')),
  expires_at timestamptz not null,
  admission_jti text,
  order_id uuid,
  release_reason text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index reservations_expiry_idx on reservations (expires_at) where status = 'ACTIVE';
create index reservations_type_active_idx on reservations (ticket_type_id) where status = 'ACTIVE';
create index reservations_user_idx on reservations (user_id, event_date_id) where status = 'ACTIVE';

create table reservation_seats (
  reservation_id uuid not null references reservations (id) on delete cascade,
  event_date_id uuid not null,
  seat_id uuid not null,
  ticket_type_id uuid not null,
  -- true mientras la reserva está activa o vendida.
  holding boolean not null default true,
  primary key (reservation_id, seat_id)
);
-- Última línea de defensa (ADR-03): una sola reserva activa o venta por (fecha, butaca).
create unique index reservation_seats_one_holder on reservation_seats (event_date_id, seat_id)
  where holding;
