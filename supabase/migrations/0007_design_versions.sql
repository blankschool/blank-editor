-- Histórico de versões nomeado (Editar → Histórico): snapshots imutáveis do documento de um
-- design, criados manualmente pela pessoa (diferente do versionamento automático de gerações em
-- 0005_generation_review_and_media.sql, que é por generation_id, não por template).
create table if not exists public.design_versions (
  id uuid primary key default gen_random_uuid(),
  template_id text not null references public.templates (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  document jsonb not null,
  created_at timestamptz not null default now()
);

-- A lista de versões de um design é sempre por template_id, mais recente primeiro.
create index if not exists design_versions_template_idx
  on public.design_versions (template_id, created_at desc);

alter table public.design_versions enable row level security;

-- Sem policy de update: uma versão é um snapshot imutável — "restaurar" copia o documento dela
-- de volta pro template, "duplicar" cria uma versão NOVA a partir dela; a linha em si nunca muda.
create policy "design_versions_select_own" on public.design_versions
  for select using (owner_id = auth.uid());
create policy "design_versions_insert_own" on public.design_versions
  for insert with check (owner_id = auth.uid());
create policy "design_versions_delete_own" on public.design_versions
  for delete using (owner_id = auth.uid());
