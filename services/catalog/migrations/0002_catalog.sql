-- Catálogo: recintos (sectores y butacas), eventos (fechas y tipos de entrada), productos y media.
-- Reemplaza las tablas homónimas de Supabase (RLS → autorización en el servicio).
-- Montos en CLP como bigint (sin decimales). La disponibilidad (vendidos/reservados) es de
-- `inventory`: aquí solo vive la capacidad publicada.

create table media (
  id uuid primary key,
  -- Hash del archivo ya procesado: la misma imagen subida dos veces se guarda una vez.
  sha256 text not null unique,
  content_type text not null check (content_type in ('image/webp')),
  bytes integer not null check (bytes > 0),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  data bytea not null,
  uploaded_by uuid not null,
  created_at timestamptz not null default now()
);

create table venues (
  id uuid primary key,
  name text not null,
  city text not null,
  address text,
  capacity integer not null default 0 check (capacity >= 0),
  map_width integer not null default 1000 check (map_width > 0),
  map_height integer not null default 760 check (map_height > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table venue_sections (
  id uuid primary key,
  venue_id uuid not null references venues (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('seated', 'general')),
  capacity integer not null default 0 check (capacity >= 0),
  sort_order integer not null default 0,
  shape_x integer not null default 0,
  shape_y integer not null default 0,
  shape_w integer not null default 200 check (shape_w > 0),
  shape_h integer not null default 120 check (shape_h > 0),
  created_at timestamptz not null default now()
);
create index venue_sections_venue_idx on venue_sections (venue_id, sort_order);

create table venue_seats (
  id uuid primary key,
  section_id uuid not null references venue_sections (id) on delete cascade,
  row_label text not null,
  seat_number integer not null check (seat_number > 0),
  x numeric(8, 2) not null,
  y numeric(8, 2) not null,
  blocked boolean not null default false,
  unique (section_id, row_label, seat_number)
);

create table events (
  id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null,
  artist text,
  category text not null check (category in ('conciertos', 'teatro', 'festivales', 'deportes', 'familia')),
  description text,
  image_id uuid references media (id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'published', 'soldout', 'archived')),
  featured boolean not null default false,
  urgency_note text,
  age_restriction text,
  -- Organizador dueño (reemplaza RLS): puede administrar solo sus eventos; null = de la plataforma.
  owner_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_status_idx on events (status);
create index events_owner_idx on events (owner_id) where owner_id is not null;

create table event_dates (
  id uuid primary key,
  event_id uuid not null references events (id) on delete cascade,
  venue_id uuid not null references venues (id) on delete restrict,
  starts_at timestamptz not null,
  doors_at timestamptz,
  on_sale boolean not null default true,
  created_at timestamptz not null default now(),
  check (doors_at is null or doors_at <= starts_at)
);
create index event_dates_event_idx on event_dates (event_id, starts_at);
create index event_dates_venue_idx on event_dates (venue_id);

-- Tipo de entrada = `ItemVendible` de kind `ticket_type` (un sector de una fecha).
create table ticket_types (
  id uuid primary key,
  event_date_id uuid not null references event_dates (id) on delete cascade,
  -- restrict: no se borra un sector que ya tiene entradas publicadas.
  section_id uuid not null references venue_sections (id) on delete restrict,
  name text not null,
  price bigint not null check (price >= 0),
  service_fee bigint not null default 0 check (service_fee >= 0),
  capacity integer not null check (capacity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_date_id, section_id)
);
create index ticket_types_section_idx on ticket_types (section_id);

-- Producto (RF03, RF14) = `ItemVendible` de kind `product`.
create table products (
  id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  description text,
  sku text unique,
  price bigint not null check (price >= 0),
  service_fee bigint not null default 0 check (service_fee >= 0),
  image_id uuid references media (id) on delete set null,
  -- Merchandising asociado a un evento (opcional).
  event_id uuid references events (id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  max_per_order integer not null default 10 check (max_per_order between 1 and 100),
  -- Vendedor dueño (rol `seller`); null = de la plataforma.
  owner_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_status_idx on products (status);
create index products_event_idx on products (event_id) where event_id is not null;
create index products_owner_idx on products (owner_id) where owner_id is not null;
