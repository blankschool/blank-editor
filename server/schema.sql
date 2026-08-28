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

-- The signed-in identity shown in the console's header/account screen. Created by
-- POST /api/v1/workspace (the signup form) and looked up by GET
-- /api/v1/workspace/by-email/:email (the login form) — see console/workspace.ts
-- and session.ts on the client for why this exists: the header used to show a
-- hardcoded "Studio do Miguel" regardless of who was actually signed in.
--
-- No password column on purpose, not yet: nothing in this app checks a password
-- against anything (LoginApp.tsx's "senha" field is validated for length only).
-- Adding a password_hash column without also building real verification would
-- just be a second thing pretending to be real security when it isn't — that's
-- separate work, and this table doesn't block it (a hash column and a login
-- check are additive later).
create table if not exists workspaces (
  id text primary key,
  name text not null,
  email text not null unique,
  created_at timestamptz not null default now()
);
