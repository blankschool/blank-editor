-- Fontes como dado do design, não como configuração de infraestrutura.
--
-- Uma arte importada de um PDF do Canva traz as famílias dela embutidas (AniconSans,
-- NYTFranklin…). Elas não existem no navegador de quem abre nem no container que renderiza.
-- Enquanto ficavam commitadas no repo e instaladas nas imagens Docker, cada PDF novo exigia
-- commit + redeploy do front E da API — e um design importado num ambiente ficava sem fonte no
-- outro. Aqui a fonte vira linha de banco + blob no storage, e importar é só uma chamada de API.

-- DOIS buckets, e a separação é sobre licença, não sobre conveniência.
--
-- O WOFF2 precisa ser público: o @font-face do navegador busca sem credencial, e não há como
-- assinar uma URL que o CSS vai reusar por horas. É o formato web, o que se espera distribuir.
--
-- O SFNT (.ttf/.otf) é privado. É o arquivo INSTALÁVEL, e as faces extraídas de PDF trazem
-- flags de embedding reais — a NYTFranklin deste projeto marca fsType 0x0004 (Preview & Print).
-- Deixá-lo baixável por URL sem credencial seria redistribuir fonte licenciada. Quem lê é só o
-- renderer, com a chave service-role, servidor a servidor.
insert into storage.buckets (id, name, public)
values ('fonts', 'fonts', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('font-sfnt', 'font-sfnt', false)
on conflict (id) do nothing;

drop policy if exists "fonts_public_read" on storage.objects;
create policy "fonts_public_read" on storage.objects
  for select using (bucket_id = 'fonts');

-- Sem policy de leitura para 'font-sfnt': o acesso é exclusivamente service-role, que ignora
-- RLS de propósito. Ausência de policy aqui é a decisão, não esquecimento.

-- Uma linha por FACE (peso/estilo), nunca por família nem por coleção: TTC/OTC são separadas em
-- faces standalone na ingestão, para que browser e renderer recebam exatamente a mesma face
-- lógica, sem depender de um índice dentro de um arquivo com várias fontes.
create table if not exists public.font_faces (
  id text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,

  -- Identidade da face: sha256 dos BYTES do SFNT. Identidade binária, não canônica — dois
  -- arquivos com as mesmas tabelas em ordem diferente contam como faces distintas, e tudo bem:
  -- o que se quer garantir é que um design antigo nunca mude de aparência.
  sha256 text not null,

  -- Lidos de dentro do arquivo, não do nome dele. `internal_family` é o name ID 1, que é o que
  -- o rasterizador casa com o `font-family` do SVG.
  internal_family text not null,
  postscript_name text,
  weight int not null,
  style text not null,
  stretch text,

  -- Flag de embedding da tabela OS/2. Registrado, não bloqueante: 0x0004 (Preview & Print)
  -- aparece de verdade nas faces extraídas de PDF, e a decisão sobre o que fazer com isso é de
  -- quem opera, não do importador.
  os2_fs_type int,

  sfnt_path text not null,   -- ref supabase://font-sfnt/... — privado, só o renderer lê
  woff2_path text not null,  -- URL pública no bucket fonts — o que o navegador carrega
  created_at timestamptz not null default now(),

  -- Dedup por dono: a mesma face usada em dez designs é uma linha e um blob.
  unique (owner_id, sha256)
);

create index if not exists font_faces_owner_id_idx on public.font_faces (owner_id);

alter table public.font_faces enable row level security;

drop policy if exists "font_faces_select_own" on public.font_faces;
create policy "font_faces_select_own" on public.font_faces
  for select using (owner_id = auth.uid());
drop policy if exists "font_faces_insert_own" on public.font_faces;
create policy "font_faces_insert_own" on public.font_faces
  for insert with check (owner_id = auth.uid());
drop policy if exists "font_faces_delete_own" on public.font_faces;
create policy "font_faces_delete_own" on public.font_faces
  for delete using (owner_id = auth.uid());
