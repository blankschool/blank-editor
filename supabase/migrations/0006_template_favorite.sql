-- Favoritar designs (Conta → Designs): coluna simples em templates, sem tabela nova — é um
-- flag de UI por dono, não um dado que precisa de histórico ou relação própria.
alter table public.templates
  add column if not exists favorite boolean not null default false;

-- A home ordena/filtra por favorito com frequência — sem índice, isso seria um scan completo
-- da tabela do dono a cada carregamento.
create index if not exists templates_owner_favorite_idx on public.templates (owner_id, favorite);
