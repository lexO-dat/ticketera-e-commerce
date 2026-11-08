-- Embudo de ventas por evento y día (reemplaza `event_metrics` de Supabase). Agregado diario:
-- las vistas llegan en lotes desde Redis y el resto desde eventos de dominio (inventory, orders).
create table event_metrics (
  event_id uuid not null references events (id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('view', 'add_to_cart', 'checkout', 'purchase')),
  quantity bigint not null default 0 check (quantity >= 0),
  -- CLP (entero). Solo `purchase`: monto bruto de las líneas confirmadas del evento.
  amount bigint not null default 0 check (amount >= 0),
  primary key (event_id, day, kind)
);
create index event_metrics_day_idx on event_metrics (day);

-- Suscriptores del newsletter del sitio (reemplaza `newsletter_subscribers` de Supabase).
create table newsletter_subscribers (
  email text primary key check (email = lower(email) and length(email) <= 254),
  subscribed_at timestamptz not null default now()
);
