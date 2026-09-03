import postgres from "postgres";

export function createDb(connectionString: string) {
  return postgres(connectionString, { max: 5 });
}

export type Sql = ReturnType<typeof createDb>;

/** Template documents are arbitrary caller-supplied JSON — cast at this one boundary rather than widening the type everywhere. */
function jsonValue(sql: Sql, value: unknown): Parameters<Sql["json"]>[0] {
  return value as Parameters<Sql["json"]>[0];
}

export interface TemplateRow {
  id: string;
  ownerId: string;
  kind: string;
  name: string;
  document: unknown;
}

export interface TemplateSummary {
  id: string;
  name: string;
  updatedAt: string;
}

/** The workspace that a valid, non-revoked API key belongs to — every template/key query is scoped to this id. */
export interface ApiKeyOwner {
  ownerId: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  createdAt: string;
  revoked: boolean;
}

/** Every read/write below is scoped by `ownerId` — the isolation between workspaces lives here,
 *  not only in Postgres RLS (RLS is enabled on these tables too, as a second layer, but this
 *  explicit `where owner_id = ...` is what the app actually relies on). */
export async function findTemplate(sql: Sql, ownerId: string, id: string): Promise<TemplateRow | null> {
  const rows = await sql<TemplateRow[]>`
    select id, owner_id as "ownerId", kind, name, document from templates
    where id = ${id} and owner_id = ${ownerId}
  `;
  return rows[0] ?? null;
}

export async function listTemplates(sql: Sql, ownerId: string): Promise<TemplateSummary[]> {
  const rows = await sql<{ id: string; name: string; updated_at: Date }[]>`
    select id, name, updated_at from templates where owner_id = ${ownerId} order by updated_at desc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at.toISOString() }));
}

export async function createTemplate(
  sql: Sql,
  input: { id: string; ownerId: string; kind: string; name: string; document: unknown },
): Promise<TemplateRow> {
  const rows = await sql<TemplateRow[]>`
    insert into templates (id, owner_id, kind, name, document)
    values (${input.id}, ${input.ownerId}, ${input.kind}, ${input.name}, ${sql.json(jsonValue(sql, input.document))})
    returning id, owner_id as "ownerId", kind, name, document
  `;
  return rows[0];
}

export async function updateTemplate(
  sql: Sql,
  ownerId: string,
  id: string,
  input: { name?: string; document?: unknown },
): Promise<TemplateRow | null> {
  const rows = await sql<TemplateRow[]>`
    update templates set
      name = coalesce(${input.name ?? null}, name),
      document = coalesce(${input.document !== undefined ? sql.json(jsonValue(sql, input.document)) : null}, document),
      updated_at = now()
    where id = ${id} and owner_id = ${ownerId}
    returning id, owner_id as "ownerId", kind, name, document
  `;
  return rows[0] ?? null;
}

export async function deleteTemplate(sql: Sql, ownerId: string, id: string): Promise<boolean> {
  const rows = await sql`delete from templates where id = ${id} and owner_id = ${ownerId} returning id`;
  return rows.length > 0;
}

/** Looks up the workspace that owns a (non-revoked) API key by its SHA-256 hash. */
export async function findApiKeyOwner(sql: Sql, keyHash: string): Promise<ApiKeyOwner | null> {
  const rows = await sql<{ owner_id: string }[]>`
    select owner_id from api_keys where key_hash = ${keyHash} and revoked_at is null
  `;
  return rows[0] ? { ownerId: rows[0].owner_id } : null;
}

export async function listApiKeys(sql: Sql, ownerId: string): Promise<ApiKeySummary[]> {
  const rows = await sql<{ id: string; name: string; created_at: Date; revoked_at: Date | null }[]>`
    select id, name, created_at, revoked_at from api_keys where owner_id = ${ownerId} order by created_at desc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString(), revoked: r.revoked_at !== null }));
}

export async function createApiKey(
  sql: Sql,
  input: { id: string; ownerId: string; name: string; keyHash: string },
): Promise<ApiKeySummary> {
  const rows = await sql<{ id: string; name: string; created_at: Date }[]>`
    insert into api_keys (id, owner_id, name, key_hash)
    values (${input.id}, ${input.ownerId}, ${input.name}, ${input.keyHash})
    returning id, name, created_at
  `;
  const r = rows[0];
  return { id: r.id, name: r.name, createdAt: r.created_at.toISOString(), revoked: false };
}

export async function revokeApiKey(sql: Sql, ownerId: string, id: string): Promise<boolean> {
  const rows = await sql`
    update api_keys set revoked_at = now()
    where id = ${id} and owner_id = ${ownerId} and revoked_at is null
    returning id
  `;
  return rows.length > 0;
}

/** Permanently removes a key's row — only once it's already revoked, so a live key can't be hard-deleted by mistake. */
export async function deleteApiKey(sql: Sql, ownerId: string, id: string): Promise<boolean> {
  const rows = await sql`
    delete from api_keys where id = ${id} and owner_id = ${ownerId} and revoked_at is not null returning id
  `;
  return rows.length > 0;
}

/** Uma face de fonte registrada — ver supabase/migrations/0003_design_fonts.sql. */
export interface FontFaceRow {
  id: string;
  sha256: string;
  internalFamily: string;
  postscriptName: string | null;
  weight: number;
  style: string;
  stretch: string | null;
  os2FsType: number | null;
  sfntPath: string;
  woff2Path: string;
}

export interface FontFaceInput {
  id: string;
  ownerId: string;
  sha256: string;
  internalFamily: string;
  postscriptName?: string | null;
  weight: number;
  style: string;
  stretch?: string | null;
  os2FsType?: number | null;
  sfntPath: string;
  woff2Path: string;
}

const FONT_FACE_COLUMNS = `
  id, sha256, internal_family as "internalFamily", postscript_name as "postscriptName",
  weight, style, stretch, os2_fs_type as "os2FsType",
  sfnt_path as "sfntPath", woff2_path as "woff2Path"
`;

/**
 * Registra a face, ou devolve a que já existe.
 *
 * `on conflict do update` em vez de `do nothing` porque `do nothing` não devolve linha, e quem
 * chama precisa do id para gravar em `Doc.fonts`. O update é sobre a própria chave, então é
 * idempotente: reimportar o mesmo PDF não cria uma segunda linha nem muda a identidade.
 */
export async function upsertFontFace(sql: Sql, input: FontFaceInput): Promise<FontFaceRow> {
  const rows = await sql<FontFaceRow[]>`
    insert into font_faces (
      id, owner_id, sha256, internal_family, postscript_name, weight, style, stretch,
      os2_fs_type, sfnt_path, woff2_path
    )
    values (
      ${input.id}, ${input.ownerId}, ${input.sha256}, ${input.internalFamily},
      ${input.postscriptName ?? null}, ${input.weight}, ${input.style}, ${input.stretch ?? null},
      ${input.os2FsType ?? null}, ${input.sfntPath}, ${input.woff2Path}
    )
    on conflict (owner_id, sha256) do update set sfnt_path = excluded.sfnt_path
    returning ${sql.unsafe(FONT_FACE_COLUMNS)}
  `;
  return rows[0];
}

export async function listFontFaces(sql: Sql, ownerId: string): Promise<FontFaceRow[]> {
  return sql<FontFaceRow[]>`
    select ${sql.unsafe(FONT_FACE_COLUMNS)} from font_faces
    where owner_id = ${ownerId}
    order by internal_family, weight
  `;
}
