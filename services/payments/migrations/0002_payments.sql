-- Pagos (docs/services/payments.md §4). Montos CLP en bigint. Nunca se guardan PAN, CVV ni
-- vencimiento: solo últimos 4 dígitos y tipo de pago.

create table payment_intents (
  id uuid primary key,
  order_id uuid not null,
  order_code text not null,
  user_id uuid not null,
  amount bigint not null check (amount > 0),
  -- Cargos de la plataforma incluidos en `amount` (para el ledger).
  fees bigint not null default 0 check (fees >= 0 and fees <= amount),
  currency char(3) not null default 'CLP',
  status text not null check (status in ('CREATED', 'PENDING', 'AUTHORIZED', 'FAILED', 'CANCELED',
    'EXPIRED', 'UNKNOWN', 'REFUND_PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED')),
  provider text not null,
  provider_token text unique,
  -- URL del formulario del adquirente (la abre el navegador con token_ws).
  provider_url text,
  buy_order varchar(26) not null unique,
  session_id varchar(61) not null,
  payer_email text not null,
  expires_at timestamptz not null,
  idempotency_key text not null,
  authorization_code text,
  card_last4 char(4),
  payment_type text,
  failure_reason text,
  refunded_amount bigint not null default 0 check (refunded_amount >= 0 and refunded_amount <= amount),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Un solo intento vivo (o exitoso) por orden: nunca dos cobros de la misma orden.
create unique index payment_intents_one_live_per_order on payment_intents (order_id)
  where status not in ('FAILED', 'CANCELED', 'EXPIRED');
create index payment_intents_pending_idx on payment_intents (expires_at) where status in ('CREATED', 'PENDING');
create index payment_intents_unknown_idx on payment_intents (updated_at) where status = 'UNKNOWN';
create index payment_intents_order_idx on payment_intents (order_id);

-- Auditoría de cada transición (quién, cuándo, desde dónde).
create table payment_attempt_events (
  id bigint generated always as identity primary key,
  intent_id uuid not null references payment_intents (id),
  from_status text,
  to_status text not null,
  reason text,
  provider_payload jsonb,
  actor text not null,
  request_id text,
  ip text,
  created_at timestamptz not null default now()
);
create index payment_attempt_events_intent_idx on payment_attempt_events (intent_id, id);

create table refunds (
  id uuid primary key,
  intent_id uuid not null references payment_intents (id),
  amount bigint not null check (amount > 0),
  status text not null check (status in ('PENDING', 'SUCCEEDED', 'FAILED')),
  provider_type text,
  reason text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index refunds_intent_idx on refunds (intent_id);

-- Ledger append-only de doble entrada: la suma de cada transaction_id es 0.
create table ledger_entries (
  id bigint generated always as identity primary key,
  transaction_id uuid not null,
  account text not null,
  amount bigint not null check (amount <> 0),
  intent_id uuid not null references payment_intents (id),
  created_at timestamptz not null default now()
);
create index ledger_entries_tx_idx on ledger_entries (transaction_id);
create index ledger_entries_account_idx on ledger_entries (account);
-- Append-only: ni UPDATE ni DELETE.
create function ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger_entries es append-only';
end;
$$;
create trigger ledger_entries_no_update before update or delete on ledger_entries
  for each row execute function ledger_append_only();

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
