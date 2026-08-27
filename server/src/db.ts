import postgres from "postgres";

export function createDb(connectionString: string) {
  return postgres(connectionString, { max: 5 });
}

export type Sql = ReturnType<typeof createDb>;

export interface TemplateRow {
  id: string;
  kind: string;
  name: string;
}

export interface ApiKeyOwner {
  id: string;
  name: string;
}

/** Looks up a template by id, scoped to the given kind (e.g. "tweet") — returns null if not found or wrong kind. */
export async function findTemplate(sql: Sql, id: string, kind: string): Promise<TemplateRow | null> {
  const rows = await sql<TemplateRow[]>`
    select id, kind, name from templates where id = ${id} and kind = ${kind}
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
