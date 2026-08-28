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

export interface Workspace {
  id: string;
  name: string;
  email: string;
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

/**
 * Legado: a identidade "de mentirinha" antes do Supabase Auth (fase 3). Fica até o corte do
 * frontend (fase 5) estar estável em produção — ver server/schema.sql e o plano de migração.
 */
export async function findWorkspaceByEmail(sql: Sql, email: string): Promise<Workspace | null> {
  const rows = await sql<Workspace[]>`
    select id, name, email from workspaces where email = ${email.toLowerCase()}
  `;
  return rows[0] ?? null;
}

export async function createWorkspace(
  sql: Sql,
  input: { id: string; name: string; email: string },
): Promise<Workspace> {
  const rows = await sql<Workspace[]>`
    insert into workspaces (id, name, email)
    values (${input.id}, ${input.name}, ${input.email.toLowerCase()})
    returning id, name, email
  `;
  return rows[0];
}
