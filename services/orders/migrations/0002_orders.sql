-- Órdenes y promociones (RF06, RF08, RF10, RF12). Montos CLP en bigint, calculados en el servidor.

create table promo_codes (
  id uuid primary key,
  code text not null unique check (code ~ '^[A-Z0-9_-]{2,40}$'),
  percent_off integer not null check (percent_off between 1 and 100),
  max_uses integer not null check (max_uses > 0),
  -- Contador atómico: UPDATE … WHERE used_count < max_uses (nunca leer-modificar-escribir).
  used_count integer not null default 0 check (used_count >= 0 and used_count <= max_uses),
  valid_until timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key,
  order_code text not null unique,
  user_id uuid not null,
  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text,
  buyer_document text,
  subtotal bigint not null check (subtotal >= 0),
  fees bigint not null check (fees >= 0),
  discount bigint not null default 0 check (discount >= 0 and discount <= subtotal),
  total bigint not null check (total = subtotal - discount + fees),
  promo_code text,
  status text not null check (status in ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED',
    'REFUND_PENDING', 'REFUNDED')),
  cancel_reason text,
  payment_id uuid,
  -- Vencimiento de las reservas: después no se puede cobrar.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index orders_user_idx on orders (user_id, created_at desc);
create index orders_pending_idx on orders (expires_at) where status = 'PENDING_PAYMENT';

-- Líneas: cualquier `ItemVendible` (entradas, productos…), con su precio congelado.
create table order_lines (
  id uuid primary key,
  order_id uuid not null references orders (id) on delete cascade,
  kind text not null,
  item_id uuid not null,
  name text not null,
  quantity integer not null check (quantity > 0),
  unit_price bigint not null check (unit_price >= 0),
  unit_fee bigint not null check (unit_fee >= 0),
  reservation_id uuid unique,
  event_id uuid,
  event_date_id uuid,
  seat_ids uuid[] not null default '{}',
  attributes jsonb not null default '{}'
);
create index order_lines_order_idx on order_lines (order_id);

create table if not exists idempotency_keys (
  scope text not null,
  key text not null,
  request_hash text not null,
  status_code integer,
  response jsonb,
  locked_until timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (scope, key)
);
