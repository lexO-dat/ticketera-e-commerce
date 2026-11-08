-- Fila virtual por evento (ADR-06). catalog es dueño de la configuración; queue la aplica.
alter table events
  add column queue_enabled boolean not null default false,
  add column queue_opens_at timestamptz,
  add column queue_concurrent_slots integer not null default 200
    check (queue_concurrent_slots between 1 and 10000),
  add column queue_window_minutes integer not null default 10
    check (queue_window_minutes between 1 and 120),
  add column queue_admit_batch_max integer not null default 50
    check (queue_admit_batch_max between 1 and 1000),
  add column queue_waiting_message text;

-- Configuración del prototipo (queue_config de Supabase) para los eventos de demostración, si ya
-- se cargaron antes de esta migración. En una base sin el seed no afecta ninguna fila.
update events set queue_enabled = true, queue_concurrent_slots = 250, queue_window_minutes = 10,
  queue_waiting_message = 'Estás en la fila virtual. Puedes recargar la página: tu turno se conserva.'
where id = 'e0000000-0000-0000-0000-000000000001';
update events set queue_enabled = true, queue_concurrent_slots = 400, queue_window_minutes = 8,
  queue_waiting_message = 'Alta demanda. Te avisaremos cuando sea tu turno.'
where id = 'e0000000-0000-0000-0000-000000000002';
update events set queue_enabled = true, queue_concurrent_slots = 150, queue_window_minutes = 12,
  queue_waiting_message = 'Fila virtual activa por alta demanda.'
where id = 'e0000000-0000-0000-0000-000000000007';
