-- Fontes importadas compõem a biblioteca de todos os usuários autenticados.
-- owner_id mantém a autoria e as políticas de escrita existentes.
drop policy if exists "font_faces_select_own" on public.font_faces;
drop policy if exists "font_faces_select_authenticated" on public.font_faces;
create policy "font_faces_select_authenticated" on public.font_faces
  for select to authenticated using (true);

create index if not exists font_faces_sha256_idx on public.font_faces (sha256);
