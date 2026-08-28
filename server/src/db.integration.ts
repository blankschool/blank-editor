/**
 * Teste de integração de verdade contra o Postgres local do Supabase (fase 0/1 do plano de
 * migração) — não roda em `npm test` (não bate no padrão `*.test.ts` do runner do Node) porque
 * depende de `supabase start` estar de pé. Rodar com `npm run test:integration` depois de
 * `supabase start` e `supabase db reset`.
 *
 * O que importa aqui: `owner_id` isola de verdade. Sem este teste, um erro de digitação no
 * `where owner_id = ...` de db.ts (ex.: comparar com o id errado) passaria despercebido pelos
 * testes unitários, que usam deps in-memory e nunca tocam RLS/foreign keys de verdade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createDb,
  createTemplate,
  findTemplate,
  listTemplates,
  deleteTemplate,
  createApiKey,
  findApiKeyOwner,
  listApiKeys,
} from "./db.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Criados via `supabase start` local (Auth admin API) neste ambiente — ver a nota do plano de
// migração. Se estes usuários não existirem no seu Postgres local, crie-os antes de rodar:
// curl -X POST http://127.0.0.1:54321/auth/v1/admin/users -H "apikey: <service_role>" ...
const OWNER_A = process.env.TEST_OWNER_A_ID ?? "d48be596-4ee4-43af-a0cf-81d3062795cd";
const OWNER_B = process.env.TEST_OWNER_B_ID ?? "3b80a061-a531-4eab-8a6f-e0e171ac496f";

const sql = createDb(DATABASE_URL);

test("um dono nunca enxerga o template do outro por findTemplate/listTemplates", async () => {
  const docA = { active: 0, pages: [{ w: 10, h: 10, bg: "#000", els: [] }] };
  const docB = { active: 0, pages: [{ w: 20, h: 20, bg: "#fff", els: [] }] };

  const tplA = await createTemplate(sql, { id: `it-a-${randomUUID()}`, ownerId: OWNER_A, kind: "custom", name: "Do A", document: docA });
  const tplB = await createTemplate(sql, { id: `it-b-${randomUUID()}`, ownerId: OWNER_B, kind: "custom", name: "Do B", document: docB });

  try {
    // A não enxerga o template de B por id, mesmo sabendo o id certo.
    assert.equal(await findTemplate(sql, OWNER_A, tplB.id), null);
    assert.equal(await findTemplate(sql, OWNER_B, tplA.id), null);

    // Cada um só vê o seu próprio na listagem.
    const listA = await listTemplates(sql, OWNER_A);
    const listB = await listTemplates(sql, OWNER_B);
    assert.ok(listA.some((t) => t.id === tplA.id));
    assert.ok(!listA.some((t) => t.id === tplB.id));
    assert.ok(listB.some((t) => t.id === tplB.id));
    assert.ok(!listB.some((t) => t.id === tplA.id));
  } finally {
    await deleteTemplate(sql, OWNER_A, tplA.id);
    await deleteTemplate(sql, OWNER_B, tplB.id);
  }
});

test("findApiKeyOwner devolve o ownerId de quem criou a chave, isolado por dono", async () => {
  const keyA = await createApiKey(sql, { id: `key-a-${randomUUID()}`, ownerId: OWNER_A, name: "chave de A", keyHash: `hash-${randomUUID()}` });
  try {
    const owner = await findApiKeyOwner(sql, (await sql<{ key_hash: string }[]>`select key_hash from api_keys where id = ${keyA.id}`)[0].key_hash);
    assert.deepEqual(owner, { ownerId: OWNER_A });

    const keysForB = await listApiKeys(sql, OWNER_B);
    assert.ok(!keysForB.some((k) => k.id === keyA.id));
  } finally {
    await sql`delete from api_keys where id = ${keyA.id}`;
  }
});

test.after(async () => {
  await sql.end();
});
