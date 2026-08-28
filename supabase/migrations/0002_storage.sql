-- Dois buckets: "renders" público (PNG gerado, link estável de download) e "uploads"
-- privado, isolado por dono (fotos que a pessoa sobe pro avatar/media). Caminho dentro
-- de "uploads" segue a convenção {owner_id}/{arquivo} — é o que a policy usa pra isolar.

insert into storage.buckets (id, name, public)
values ('renders', 'renders', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

-- Leitura pública de "renders" para qualquer um (é o link de download). Escrita só
-- acontece pelo servidor com a chave service-role, que já ignora RLS — de propósito,
-- não existe policy de insert/update aqui para authenticated/anon.
create policy "renders_public_read" on storage.objects
  for select using (bucket_id = 'renders');

-- "uploads" é privado: cada dono só enxerga o que está sob a própria pasta.
create policy "uploads_select_own" on storage.objects
  for select using (
    bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "uploads_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "uploads_delete_own" on storage.objects
  for delete using (
    bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text
  );
