-- blank-editor on Supabase: identity moves to auth.users; templates/api_keys gain
-- owner_id and real per-workspace isolation. Isolamento de verdade é o WHERE owner_id = $1
-- que o server escreve em toda query (server/src/db.ts) — RLS aqui é uma segunda camada,
-- não o mecanismo principal, decisão tomada com o usuário durante o planejamento.

-- Espelho só de exibição de auth.users (nome/e-mail pro header do console, tela Conta).
-- Populada por trigger — nunca escrita direto pelo app.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.email
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.templates (
  id text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  name text not null,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists templates_owner_id_idx on public.templates (owner_id);

alter table public.templates enable row level security;

create policy "templates_select_own" on public.templates
  for select using (owner_id = auth.uid());
create policy "templates_insert_own" on public.templates
  for insert with check (owner_id = auth.uid());
create policy "templates_update_own" on public.templates
  for update using (owner_id = auth.uid());
create policy "templates_delete_own" on public.templates
  for delete using (owner_id = auth.uid());

create table if not exists public.api_keys (
  id text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  key_hash text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists api_keys_owner_id_idx on public.api_keys (owner_id);
create index if not exists api_keys_key_hash_idx on public.api_keys (key_hash) where revoked_at is null;

alter table public.api_keys enable row level security;

create policy "api_keys_select_own" on public.api_keys
  for select using (owner_id = auth.uid());
create policy "api_keys_insert_own" on public.api_keys
  for insert with check (owner_id = auth.uid());
create policy "api_keys_update_own" on public.api_keys
  for update using (owner_id = auth.uid());
create policy "api_keys_delete_own" on public.api_keys
  for delete using (owner_id = auth.uid());
