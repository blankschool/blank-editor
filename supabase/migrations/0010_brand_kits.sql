-- Painel de design system/marca (Editar → Marca). Paletas de cor/fonte salvas POR CONTA, não por
-- design — o ponto é serem reaproveitáveis entre designs diferentes (diferente de
-- design_versions/design_comments, que são sempre de UM template). Por isso as rotas são
-- `/api/v1/brand-kits`, sem `template_id` nenhum.
create table if not exists public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  colors jsonb not null default '[]'::jsonb,
  fonts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists brand_kits_owner_idx on public.brand_kits (owner_id, created_at desc);

alter table public.brand_kits enable row level security;

create policy "brand_kits_select_own" on public.brand_kits
  for select using (owner_id = auth.uid());
create policy "brand_kits_insert_own" on public.brand_kits
  for insert with check (owner_id = auth.uid());
create policy "brand_kits_delete_own" on public.brand_kits
  for delete using (owner_id = auth.uid());
