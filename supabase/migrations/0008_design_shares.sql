-- Compartilhamento com link público (Editar → Compartilhar). Uma linha por design, "private"
-- por padrão — sem linha nenhuma OU visibility='private', a rota pública nem confere o resto,
-- responde 404 igual a design inexistente (não revela "existe mas é privado").
create table if not exists public.design_shares (
  template_id text primary key references public.templates (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  visibility text not null default 'private' check (visibility in ('private', 'link')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists design_shares_owner_idx on public.design_shares (owner_id);

alter table public.design_shares enable row level security;

-- A leitura pública (visitante anônimo em /p/:id) NUNCA passa por aqui — o server consulta essa
-- tabela com a conexão direta ao Postgres (DATABASE_URL), do mesmo jeito que já faz pra
-- templates/api_keys (ver o comentário em 0001_init.sql: RLS é a segunda camada, o
-- `where owner_id = $1`/`where visibility = 'link'` escrito à mão na query é a garantia real).
create policy "design_shares_select_own" on public.design_shares
  for select using (owner_id = auth.uid());
create policy "design_shares_upsert_own" on public.design_shares
  for insert with check (owner_id = auth.uid());
create policy "design_shares_update_own" on public.design_shares
  for update using (owner_id = auth.uid());
