-- Histórico de versões nomeado (Editar → Histórico): snapshots imutáveis do documento de um
-- design, criados manualmente pela pessoa. Chamada `template_versions`, NÃO `design_versions` —
-- esse nome já existe em 0005_generation_review_and_media.sql pra uma coisa diferente (snapshot
-- por generation_id, criado automaticamente a cada geração de IA revisada, não por template_id
-- criado manualmente). Uma colisão de nome entre as duas passou despercebida numa aplicação real
-- porque a 0005 nunca tinha sido aplicada ainda: `create table if not exists` faz nada quando a
-- tabela já existe, então aplicar as duas em qualquer ordem deixaria uma delas com o esquema da
-- outra — só apareceu na prática ao ligar num Postgres que já tinha as duas migrations pendentes.
create table if not exists public.template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id text not null references public.templates (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  document jsonb not null,
  created_at timestamptz not null default now()
);

-- A lista de versões de um design é sempre por template_id, mais recente primeiro.
create index if not exists template_versions_template_idx
  on public.template_versions (template_id, created_at desc);

alter table public.template_versions enable row level security;

-- Sem policy de update: uma versão é um snapshot imutável — "restaurar" copia o documento dela
-- de volta pro template, "duplicar" cria uma versão NOVA a partir dela; a linha em si nunca muda.
create policy "template_versions_select_own" on public.template_versions
  for select using (owner_id = auth.uid());
create policy "template_versions_insert_own" on public.template_versions
  for insert with check (owner_id = auth.uid());
create policy "template_versions_delete_own" on public.template_versions
  for delete using (owner_id = auth.uid());
