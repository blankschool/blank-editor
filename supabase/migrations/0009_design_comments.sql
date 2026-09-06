-- Comentários fixados no canvas (Editar → Comentários). Um comentário é do DESIGN inteiro, não
-- de uma versão específica (template_versions em 0007_template_versions.sql é outra coisa:
-- snapshot imutável do documento) — mais simples, e uma versão restaurada não devia apagar o
-- histórico de discussão sobre o design. `page_index`/`x`/`y` fixam o pino relativo à página
-- (x/y normalizados 0..1, como El.imgX/imgY do crop de imagem) — não em pixels, pra sobreviver a
-- redimensionar a página.
create table if not exists public.design_comments (
  id uuid primary key default gen_random_uuid(),
  template_id text not null references public.templates (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  page_index integer not null default 0,
  x real not null,
  y real not null,
  body text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists design_comments_template_idx
  on public.design_comments (template_id, created_at desc);

create table if not exists public.design_comment_replies (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.design_comments (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists design_comment_replies_comment_idx
  on public.design_comment_replies (comment_id, created_at asc);

alter table public.design_comments enable row level security;
alter table public.design_comment_replies enable row level security;

-- Só o dono do design — não existe conceito de time/colaborador convidado neste app ainda (só
-- compartilhamento público READ-ONLY em design_shares), então "comentários" hoje é o dono
-- deixando notas fixadas pra si mesmo, não uma discussão entre pessoas diferentes.
create policy "design_comments_select_own" on public.design_comments
  for select using (owner_id = auth.uid());
create policy "design_comments_insert_own" on public.design_comments
  for insert with check (owner_id = auth.uid());
create policy "design_comments_update_own" on public.design_comments
  for update using (owner_id = auth.uid());
create policy "design_comments_delete_own" on public.design_comments
  for delete using (owner_id = auth.uid());

create policy "design_comment_replies_select_own" on public.design_comment_replies
  for select using (owner_id = auth.uid());
create policy "design_comment_replies_insert_own" on public.design_comment_replies
  for insert with check (owner_id = auth.uid());
create policy "design_comment_replies_delete_own" on public.design_comment_replies
  for delete using (owner_id = auth.uid());
