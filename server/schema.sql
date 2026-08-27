-- blank-editor render API — new schema, isolated from the legacy BlankCanvas tables
-- in the same Postgres instance. No ORM: applied by hand or via a simple migration runner.

create table if not exists templates (
  id text primary key,
  kind text not null,
  name text not null,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_keys (
  id text primary key,
  key_hash text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists api_keys_key_hash_idx on api_keys (key_hash) where revoked_at is null;
