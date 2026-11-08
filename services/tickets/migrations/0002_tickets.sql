-- Entradas digitales (RF11, RF12, RF15). Una fila por acceso; el QR es un token firmado que se
-- genera al pedirlo (no se guarda), así que no hay secreto que filtrar desde la base.

create table tickets (
  id uuid primary key,
  -- Código legible para validación manual (crypto.randomBytes, nunca Math.random).
  code text not null unique,
  order_id uuid not null,
  order_code text not null,
  order_line_id uuid not null,
  -- Posición dentro de la línea (0..cantidad-1): la emisión repetida no duplica entradas.
  unit_index integer not null check (unit_index >= 0),
  user_id uuid not null,
  holder_name text not null,
  holder_email text not null,
  event_id uuid not null,
  event_date_id uuid not null,
  ticket_type_id uuid not null,
  name text not null,
  starts_at timestamptz,
  venue_name text,
  section_name text,
  seat_id uuid,
  seat_label text,
  status text not null default 'ISSUED' check (status in ('ISSUED', 'CHECKED_IN', 'VOIDED')),
  checked_in_at timestamptz,
  checked_in_by uuid,
  gate text,
  voided_at timestamptz,
  void_reason text,
  issued_at timestamptz not null default now(),
  unique (order_line_id, unit_index)
);
create index tickets_user_idx on tickets (user_id, issued_at desc);
create index tickets_order_idx on tickets (order_id);
create index tickets_date_idx on tickets (event_date_id, status);
-- Una butaca de una función solo puede estar en una entrada vigente.
create unique index tickets_one_per_seat on tickets (event_date_id, seat_id)
  where seat_id is not null and status <> 'VOIDED';

-- Auditoría de cada escaneo en puerta (aceptado o no).
create table checkins (
  id bigint generated always as identity primary key,
  ticket_id uuid references tickets (id),
  event_date_id uuid not null,
  result text not null check (result in ('ACCEPTED', 'ALREADY_USED', 'VOIDED', 'WRONG_EVENT', 'INVALID')),
  scanned_by uuid not null,
  gate text,
  created_at timestamptz not null default now()
);
create index checkins_date_idx on checkins (event_date_id, created_at desc);
