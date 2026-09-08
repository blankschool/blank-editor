-- Mínimo do Supabase para as migrations rodarem num Postgres puro.
--
-- As migrations em supabase/migrations/ são as MESMAS que produção usa — não há uma versão
-- "de dev" delas, justamente para que o schema local e o de produção não divirjam. Mas elas
-- referenciam objetos que o Supabase cria por conta própria (auth.users, auth.uid(),
-- storage.objects). Sem isto, a primeira migration falha e o banco sobe vazio.
--
-- Isto é um SUBSTITUTO DE DESENVOLVIMENTO, não uma reimplementação do Supabase: só existe
-- o suficiente para as migrations aplicarem e as foreign keys valerem. Em produção nada
-- disto roda — lá quem cria estes objetos é o próprio Supabase.

create schema if not exists auth;
create schema if not exists storage;

-- Só as três colunas que as migrations tocam (ver o trigger handle_new_user na 0001).
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Em produção auth.uid() lê o JWT da requisição. Aqui devolve o valor de uma GUC que o
-- servidor não usa: o isolamento real do app é o `where owner_id = $1` que db.ts escreve em
-- toda query, e as policies de RLS são a segunda camada (ver o comentário no topo da 0001).
-- Devolver null faz as policies negarem por padrão, que é o lado seguro para errar.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets (id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;

-- storage.foldername('pasta/arquivo.png') -> {pasta}: as policies de "uploads" usam o
-- primeiro segmento como dono.
create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(regexp_replace(name, '/[^/]*$', ''), '/');
$$;

-- ---------------------------------------------------------------------------------------
-- intel.art_renders: tabela de OUTRO sistema (o pipeline Intel), que em produção divide o
-- mesmo banco. Não é do Blank Editor — por isso a migration 0004 só faz `alter table` nela,
-- nunca `create`. Um banco local novo não tem motivo para tê-la, e sem ela a 0004 falha e
-- o banco inteiro sobe pela metade.
--
-- Aqui existe só o suficiente para a 0004 aplicar e para o fluxo de aprovação de geração
-- funcionar (server/src/db.ts escreve status/review_status/approved_* nesta tabela). NÃO é
-- o schema real do pipeline Intel: as colunas abaixo são as que este app toca, mais nada.
create schema if not exists intel;

create table if not exists intel.art_renders (
  id uuid primary key default gen_random_uuid(),
  -- Nullable já de saída: é exatamente o que a 0004 faz com `drop not null`.
  template_id uuid,
  generation_id uuid,
  page integer not null default 1,
  status text,
  review_status text,
  design_version integer,
  approved_at timestamptz,
  approved_png_url text,
  png_path text,
  created_at timestamptz not null default now()
);
