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
  kind: string;
  name: string;
  document: unknown;
}

export interface TemplateSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface ApiKeyOwner {
  id: string;
  name: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  createdAt: string;
  revoked: boolean;
}

export async function findTemplate(sql: Sql, id: string): Promise<TemplateRow | null> {
  const rows = await sql<TemplateRow[]>`
    select id, kind, name, document from templates where id = ${id}
  `;
  return rows[0] ?? null;
}

export async function listTemplates(sql: Sql): Promise<TemplateSummary[]> {
  const rows = await sql<{ id: string; name: string; updated_at: Date }[]>`
    select id, name, updated_at from templates order by updated_at desc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at.toISOString() }));
}

export async function createTemplate(
  sql: Sql,
  input: { id: string; kind: string; name: string; document: unknown },
): Promise<TemplateRow> {
  const rows = await sql<TemplateRow[]>`
    insert into templates (id, kind, name, document)
    values (${input.id}, ${input.kind}, ${input.name}, ${sql.json(jsonValue(sql, input.document))})
    returning id, kind, name, document
  `;
  return rows[0];
}

export async function updateTemplate(
  sql: Sql,
  id: string,
  input: { name?: string; document?: unknown },
): Promise<TemplateRow | null> {
  const rows = await sql<TemplateRow[]>`
    update templates set
      name = coalesce(${input.name ?? null}, name),
      document = coalesce(${input.document !== undefined ? sql.json(jsonValue(sql, input.document)) : null}, document),
      updated_at = now()
    where id = ${id}
    returning id, kind, name, document
  `;
  return rows[0] ?? null;
}

/** Looks up the (non-revoked) owner of an API key by its SHA-256 hash. */
export async function findApiKeyOwner(sql: Sql, keyHash: string): Promise<ApiKeyOwner | null> {
  const rows = await sql<ApiKeyOwner[]>`
    select id, name from api_keys where key_hash = ${keyHash} and revoked_at is null
  `;
  return rows[0] ?? null;
}

export async function listApiKeys(sql: Sql): Promise<ApiKeySummary[]> {
  const rows = await sql<{ id: string; name: string; created_at: Date; revoked_at: Date | null }[]>`
    select id, name, created_at, revoked_at from api_keys order by created_at desc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString(), revoked: r.revoked_at !== null }));
}

export async function createApiKey(
  sql: Sql,
  input: { id: string; name: string; keyHash: string },
): Promise<ApiKeySummary> {
  const rows = await sql<{ id: string; name: string; created_at: Date }[]>`
    insert into api_keys (id, name, key_hash)
    values (${input.id}, ${input.name}, ${input.keyHash})
    returning id, name, created_at
  `;
  const r = rows[0];
  return { id: r.id, name: r.name, createdAt: r.created_at.toISOString(), revoked: false };
}

export async function revokeApiKey(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`
    update api_keys set revoked_at = now() where id = ${id} and revoked_at is null returning id
  `;
  return rows.length > 0;
}
