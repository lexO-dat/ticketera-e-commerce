-- Identidad: reemplaza a Supabase Auth (auth.users), user_roles/has_role y profiles.

create table users (
  id uuid primary key,
  -- Normalizado (trim + minúsculas) en la aplicación; único.
  email text not null unique check (email = lower(email) and char_length(email) <= 254),
  password_hash text not null,
  full_name text not null default '' check (char_length(full_name) <= 120),
  status text not null default 'active' check (status in ('active', 'disabled')),
  email_verified_at timestamptz,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_created_at_idx on users (created_at desc, id desc);

create table user_roles (
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('customer', 'organizer', 'seller', 'staff', 'admin')),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);
create index user_roles_role_idx on user_roles (role);

-- Refresh tokens opacos, rotativos y revocables. Solo se guarda el hash del secreto.
-- `family_id` agrupa una sesión: si se reutiliza un token ya rotado, se revoca la familia completa.
create table refresh_tokens (
  id uuid primary key,
  family_id uuid not null,
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  replaced_by uuid,
  user_agent text,
  ip inet
);
create index refresh_tokens_family_idx on refresh_tokens (family_id);
create index refresh_tokens_user_active_idx on refresh_tokens (user_id) where revoked_at is null;

-- Tokens de un solo uso para enlaces enviados por correo.
create table one_time_tokens (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  purpose text not null check (purpose in ('verify_email', 'reset_password')),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index one_time_tokens_user_idx on one_time_tokens (user_id, purpose) where used_at is null;

-- Claves de firma EdDSA. La privada se guarda cifrada (AES-256-GCM con KEY_ENCRYPTION_SECRET).
-- La pública sigue publicada en el JWKS después de retirarse, hasta que venzan sus tokens.
create table signing_keys (
  kid text primary key,
  algorithm text not null default 'EdDSA',
  public_jwk jsonb not null,
  private_key_enc text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
