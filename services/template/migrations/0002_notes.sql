-- Recurso de ejemplo de la plantilla. Reemplázalo por las tablas del dominio del servicio.
create table notes (
  id uuid primary key,
  text text not null check (char_length(text) between 1 and 500),
  created_at timestamptz not null default now()
);
