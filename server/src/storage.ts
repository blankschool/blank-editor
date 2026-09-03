import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Dois buckets (supabase/migrations/0002_storage.sql): `renders` público, `uploads` privado
 *  por dono (RLS por prefixo de caminho). Cliente service-role — ignora RLS de propósito, é
 *  leitura/escrita confiável servidor-a-servidor, não uma requisição vinda do navegador. */
export function createStorageClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

const RENDERS_BUCKET = "renders";
const UPLOADS_BUCKET = "uploads";
const FONTS_BUCKET = "fonts";
const FONT_SFNT_BUCKET = "font-sfnt";

/** Prefixo que marca um `src` de layer como referência ao bucket privado, em vez de uma URL
 *  http(s) normal — é o que `renderTweet.ts` usa pra saber que precisa buscar via Storage, não
 *  via fetch guiado por SSRF. */
export const PRIVATE_UPLOAD_PREFIX = "supabase://uploads/";

/** Caminho estável por template+página (upsert) — é o que permite computar a URL pública sem
 *  guardar nada a mais no banco: ela é sempre a mesma pra um template+página dados. */
function renderPath(templateId: string, pageIndex: number): string {
  return `${templateId}/page-${pageIndex + 1}.png`;
}

export async function uploadRenderedPng(
  client: SupabaseClient,
  templateId: string,
  pageIndex: number,
  png: Buffer,
): Promise<void> {
  const { error } = await client.storage
    .from(RENDERS_BUCKET)
    .upload(renderPath(templateId, pageIndex), png, { contentType: "image/png", upsert: true });
  if (error) throw error;
}

/** A URL pública é determinística — não depende do upload já ter acontecido, por isso pode ser
 *  computada em GET /api/v1/templates/:id mesmo antes de qualquer `save:true` ter rodado (o
 *  link só resolve de verdade depois do primeiro render salvo). */
export function publicRenderUrl(client: SupabaseClient, templateId: string, pageIndex = 0): string {
  return client.storage.from(RENDERS_BUCKET).getPublicUrl(renderPath(templateId, pageIndex)).data.publicUrl;
}

/** Marca um `sfnt_path` como referência ao bucket privado de fontes, do mesmo jeito que
 *  PRIVATE_UPLOAD_PREFIX faz para as fotos — é o que diz ao renderer "busque via Storage com a
 *  chave service-role, não por fetch". */
export const FONT_SFNT_PREFIX = "supabase://font-sfnt/";

/**
 * Sobe os dois formatos de uma face (supabase/migrations/0003_design_fonts.sql).
 *
 * Endereçado por conteúdo (`{sha256}.{ext}`), não por dono: a mesma face usada em dez designs é
 * um blob só, e o nome do arquivo já é a identidade que o cache do renderer usa. `upsert` porque
 * reimportar o mesmo PDF reescreve bytes idênticos.
 *
 * O WOFF2 vai para o bucket público e volta como URL; o SFNT vai para o privado e volta como
 * referência `supabase://`. A assimetria é deliberada — ver o comentário da migration.
 */
export async function uploadFontFace(
  client: SupabaseClient,
  sha256: string,
  sfnt: { ext: string; bytes: Buffer },
  woff2: Buffer,
): Promise<{ sfntPath: string; woff2Path: string }> {
  const sfntName = `${sha256}.${sfnt.ext}`;
  const woff2Name = `${sha256}.woff2`;
  const [sfntRes, woff2Res] = await Promise.all([
    client.storage.from(FONT_SFNT_BUCKET).upload(sfntName, sfnt.bytes, { contentType: "font/ttf", upsert: true }),
    client.storage.from(FONTS_BUCKET).upload(woff2Name, woff2, { contentType: "font/woff2", upsert: true }),
  ]);
  if (sfntRes.error) throw sfntRes.error;
  if (woff2Res.error) throw woff2Res.error;
  return {
    sfntPath: FONT_SFNT_PREFIX + sfntName,
    woff2Path: client.storage.from(FONTS_BUCKET).getPublicUrl(woff2Name).data.publicUrl,
  };
}

/** Baixa o SFNT privado de uma face. Só o servidor consegue: o bucket não tem policy de leitura. */
export async function fetchFontSfnt(client: SupabaseClient, ref: string): Promise<Buffer> {
  const path = ref.startsWith(FONT_SFNT_PREFIX) ? ref.slice(FONT_SFNT_PREFIX.length) : ref;
  const { data, error } = await client.storage.from(FONT_SFNT_BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export async function uploadUserPhoto(
  client: SupabaseClient,
  ownerId: string,
  filename: string,
  contentType: string,
  data: Buffer,
): Promise<string> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${ownerId}/${Date.now()}-${safeName}`;
  const { error } = await client.storage.from(UPLOADS_BUCKET).upload(path, data, { contentType, upsert: false });
  if (error) throw error;
  return PRIVATE_UPLOAD_PREFIX + path;
}

/** `ref` é o que uma layer guarda como `src` (com o prefixo `PRIVATE_UPLOAD_PREFIX`) — só o
 *  dono consegue baixar via RLS se algo um dia chamar isto sem a chave service-role; aqui
 *  sempre usamos service-role, então a garantia real de isolamento é o caminho ser prefixado
 *  pelo ownerId, verificado em `deleteApiKey`-style em app.ts antes de aceitar a referência. */
export async function fetchPrivateUpload(client: SupabaseClient, ref: string): Promise<Buffer> {
  const path = ref.startsWith(PRIVATE_UPLOAD_PREFIX) ? ref.slice(PRIVATE_UPLOAD_PREFIX.length) : ref;
  const { data, error } = await client.storage.from(UPLOADS_BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

/** O editor roda no navegador e não tem a chave service-role — uma layer com `src` privado
 *  (`PRIVATE_UPLOAD_PREFIX`) não é uma URL que `<img>`/canvas consegue buscar direto (o esquema
 *  `supabase://` não existe pra fetch nenhum). Esta função devolve uma URL assinada, de curta
 *  duração, que o navegador já consegue carregar sozinho — GET /api/v1/uploads/resolve (app.ts)
 *  é quem confere que o `ref` pedido pertence a quem está pedindo antes de chamar isto. */
export async function signPrivateUploadUrl(client: SupabaseClient, ref: string, expiresInSeconds = 300): Promise<string> {
  const path = ref.startsWith(PRIVATE_UPLOAD_PREFIX) ? ref.slice(PRIVATE_UPLOAD_PREFIX.length) : ref;
  const { data, error } = await client.storage.from(UPLOADS_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}
