-- Outbox (eventos a publicar en la misma transacción del cambio) e inbox (deduplicación de eventos
-- consumidos). Mismo esquema que OUTBOX_INBOX_SQL en @shared/commons/db.
create table outbox (
  seq bigint generated always as identity primary key,
  id uuid not null unique,
  aggregate_id text not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index outbox_pending_idx on outbox (seq) where published_at is null;

create table inbox (
  consumer text not null,
  event_id uuid not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, event_id)
);
