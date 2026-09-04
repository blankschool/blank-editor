import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type {
  ApprovalRecord,
  DesignVersion,
  GenerationRepository,
  GenerationRun,
  MediaAssetRecord,
} from "./generationWorkflow.ts";

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
  favorite: boolean;
}

export interface TemplateSummary {
  id: string;
  name: string;
  updatedAt: string;
  favorite: boolean;
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
    select id, owner_id as "ownerId", kind, name, document, favorite from templates
    where id = ${id} and owner_id = ${ownerId}
  `;
  return rows[0] ?? null;
}

export async function listTemplates(sql: Sql, ownerId: string): Promise<TemplateSummary[]> {
  const rows = await sql<{ id: string; name: string; updated_at: Date; favorite: boolean }[]>`
    select id, name, updated_at, favorite from templates where owner_id = ${ownerId} order by updated_at desc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at.toISOString(), favorite: r.favorite }));
}

export async function createTemplate(
  sql: Sql,
  input: { id: string; ownerId: string; kind: string; name: string; document: unknown },
): Promise<TemplateRow> {
  const rows = await sql<TemplateRow[]>`
    insert into templates (id, owner_id, kind, name, document)
    values (${input.id}, ${input.ownerId}, ${input.kind}, ${input.name}, ${sql.json(jsonValue(sql, input.document))})
    returning id, owner_id as "ownerId", kind, name, document, favorite
  `;
  return rows[0];
}

export async function updateTemplate(
  sql: Sql,
  ownerId: string,
  id: string,
  input: { name?: string; document?: unknown; favorite?: boolean },
): Promise<TemplateRow | null> {
  const rows = await sql<TemplateRow[]>`
    update templates set
      name = coalesce(${input.name ?? null}, name),
      document = coalesce(${input.document !== undefined ? sql.json(jsonValue(sql, input.document)) : null}, document),
      favorite = coalesce(${input.favorite ?? null}, favorite),
      updated_at = now()
    where id = ${id} and owner_id = ${ownerId}
    returning id, owner_id as "ownerId", kind, name, document, favorite
  `;
  return rows[0] ?? null;
}

export async function deleteTemplate(sql: Sql, ownerId: string, id: string): Promise<boolean> {
  const rows = await sql`delete from templates where id = ${id} and owner_id = ${ownerId} returning id`;
  return rows.length > 0;
}

/** Um snapshot nomeado e imutável do documento de um design — histórico de versão manual,
 *  diferente do versionamento automático de gerações (generationWorkflow.ts, por generation_id). */
export interface DesignVersionRow {
  id: string;
  templateId: string;
  ownerId: string;
  name: string;
  document: unknown;
  createdAt: string;
}

const DESIGN_VERSION_COLUMNS = `
  id, template_id as "templateId", owner_id as "ownerId", name, document, created_at as "createdAt"
`;

export async function listDesignVersions(sql: Sql, ownerId: string, templateId: string): Promise<DesignVersionRow[]> {
  const rows = await sql<(Omit<DesignVersionRow, "createdAt"> & { createdAt: Date })[]>`
    select ${sql.unsafe(DESIGN_VERSION_COLUMNS)} from design_versions
    where template_id = ${templateId} and owner_id = ${ownerId}
    order by created_at desc
  `;
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function createDesignVersion(
  sql: Sql,
  input: { id: string; ownerId: string; templateId: string; name: string; document: unknown },
): Promise<DesignVersionRow> {
  const rows = await sql<(Omit<DesignVersionRow, "createdAt"> & { createdAt: Date })[]>`
    insert into design_versions (id, template_id, owner_id, name, document)
    values (${input.id}, ${input.templateId}, ${input.ownerId}, ${input.name}, ${sql.json(jsonValue(sql, input.document))})
    returning ${sql.unsafe(DESIGN_VERSION_COLUMNS)}
  `;
  const r = rows[0];
  return { ...r, createdAt: r.createdAt.toISOString() };
}

/** `templateId` também entra no where — sem isso, o id da versão sozinho já seria suficiente
 *  pra achar a linha, mas a rota chama isto como `/templates/:id/versions/:versionId`, e uma
 *  versão pedida com o id de OUTRO design não devia existir daquele ponto de vista. */
export async function findDesignVersion(
  sql: Sql,
  ownerId: string,
  templateId: string,
  id: string,
): Promise<DesignVersionRow | null> {
  const rows = await sql<(Omit<DesignVersionRow, "createdAt"> & { createdAt: Date })[]>`
    select ${sql.unsafe(DESIGN_VERSION_COLUMNS)} from design_versions
    where id = ${id} and template_id = ${templateId} and owner_id = ${ownerId}
  `;
  const r = rows[0];
  return r ? { ...r, createdAt: r.createdAt.toISOString() } : null;
}

export async function deleteDesignVersion(sql: Sql, ownerId: string, templateId: string, id: string): Promise<boolean> {
  const rows = await sql`
    delete from design_versions
    where id = ${id} and template_id = ${templateId} and owner_id = ${ownerId}
    returning id
  `;
  return rows.length > 0;
}

export type ShareVisibility = "private" | "link";

/** `visibility` de um design pro dono — sempre existe uma resposta ("private" quando não há
 *  linha nenhuma ainda), pra quem chama nunca precisar tratar "nunca configurado" como um
 *  terceiro estado. */
export async function getDesignShareVisibility(sql: Sql, ownerId: string, templateId: string): Promise<ShareVisibility> {
  const rows = await sql<{ visibility: ShareVisibility }[]>`
    select visibility from design_shares where template_id = ${templateId} and owner_id = ${ownerId}
  `;
  return rows[0]?.visibility ?? "private";
}

export async function setDesignShareVisibility(
  sql: Sql,
  ownerId: string,
  templateId: string,
  visibility: ShareVisibility,
): Promise<void> {
  await sql`
    insert into design_shares (template_id, owner_id, visibility)
    values (${templateId}, ${ownerId}, ${visibility})
    on conflict (template_id) do update set visibility = excluded.visibility, updated_at = now()
  `;
}

/** Visibilidade de um design, sem saber quem é o dono — usado pela própria rota pública antes de
 *  decidir se serve o documento (ver `findTemplatePublic`). "private" quando não há linha, igual
 *  ao lookup com dono. */
export async function getPublicShareVisibility(sql: Sql, templateId: string): Promise<ShareVisibility> {
  const rows = await sql<{ visibility: ShareVisibility }[]>`
    select visibility from design_shares where template_id = ${templateId}
  `;
  return rows[0]?.visibility ?? "private";
}

/** Só pra rota pública: SEM `owner_id` no where — de propósito, é o único lookup do arquivo que
 *  não isola por dono, porque o visitante anônimo não tem um. A garantia de acesso aqui não é
 *  "esse dono pode ver isso", é "esse design está marcado como link público" — conferido
 *  separado, em `getDesignShareVisibility`/join, antes de qualquer documento sair daqui. */
export async function findTemplatePublic(sql: Sql, id: string): Promise<TemplateRow | null> {
  const rows = await sql<TemplateRow[]>`
    select id, owner_id as "ownerId", kind, name, document, favorite from templates where id = ${id}
  `;
  return rows[0] ?? null;
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

interface GenerationDbRow extends Omit<GenerationRun, "createdAt" | "updatedAt"> {
  createdAt: Date;
  updatedAt: Date;
}

interface VersionDbRow extends Omit<DesignVersion, "createdAt"> {
  createdAt: Date;
}

interface ApprovalDbRow extends Omit<ApprovalRecord, "createdAt"> {
  createdAt: Date;
}

const GENERATION_COLUMNS = `
  id, owner_id as "ownerId", design_id as "designId",
  source_template_id as "sourceTemplateId", idempotency_key as "idempotencyKey",
  request_hash as "requestHash", processing_status as "processingStatus",
  review_status as "reviewStatus", delivery_status as "deliveryStatus",
  current_version as "currentVersion", approved_version as "approvedVersion",
  run_id as "runId", error, created_at as "createdAt", updated_at as "updatedAt"
`;

function mapGeneration(row: GenerationDbRow): GenerationRun {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function mapVersion(row: VersionDbRow): DesignVersion {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** PostgreSQL implementation of the generation aggregate. Multi-row state changes are
 * transactional so an approval can never exist without its outbox event and state update. */
export function createPostgresGenerationRepository(sql: Sql): GenerationRepository {
  return {
    async findByIdempotency(ownerId, idempotencyKey) {
      const rows = await sql<GenerationDbRow[]>`
        select ${sql.unsafe(GENERATION_COLUMNS)} from generation_runs
        where owner_id = ${ownerId} and idempotency_key = ${idempotencyKey}
      `;
      return rows[0] ? mapGeneration(rows[0]) : null;
    },
    async findById(ownerId, generationId) {
      const rows = await sql<GenerationDbRow[]>`
        select ${sql.unsafe(GENERATION_COLUMNS)} from generation_runs
        where owner_id = ${ownerId} and id = ${generationId}
      `;
      return rows[0] ? mapGeneration(rows[0]) : null;
    },
    async findByDesign(ownerId, designId) {
      const rows = await sql<GenerationDbRow[]>`
        select ${sql.unsafe(GENERATION_COLUMNS)} from generation_runs
        where owner_id = ${ownerId} and design_id = ${designId}
      `;
      return rows[0] ? mapGeneration(rows[0]) : null;
    },
    async findVersion(ownerId, generationId, version) {
      const rows = await sql<VersionDbRow[]>`
        select v.generation_id as "generationId", v.version, v.document,
          v.document_checksum as "documentChecksum", v.created_by as "createdBy",
          v.created_at as "createdAt"
        from design_versions v
        join generation_runs g on g.id = v.generation_id
        where g.owner_id = ${ownerId} and v.generation_id = ${generationId} and v.version = ${version}
      `;
      return rows[0] ? mapVersion(rows[0]) : null;
    },
    async createWithInitialVersion(input) {
      return sql.begin(async (tx) => {
        const rows = await tx<GenerationDbRow[]>`
          insert into generation_runs (
            id, owner_id, design_id, source_template_id, idempotency_key, request_hash,
            processing_status, review_status, delivery_status, current_version, run_id
          ) values (
            ${input.id}, ${input.ownerId}, ${input.designId}, ${input.sourceTemplateId},
            ${input.idempotencyKey}, ${input.requestHash}, 'ready', 'pending', 'blocked', 1,
            ${input.runId ?? null}
          )
          returning ${tx.unsafe(GENERATION_COLUMNS)}
        `;
        await tx`
          insert into design_versions (
            generation_id, version, owner_id, document, document_checksum, created_by
          ) values (
            ${input.id}, 1, ${input.ownerId}, ${tx.json(jsonValue(sql, input.document))},
            ${input.documentChecksum}, ${input.createdBy ?? null}
          )
        `;
        await tx`
          insert into outbox_events (owner_id, generation_id, event_type, payload)
          values (${input.ownerId}, ${input.id}, 'generation.awaiting_approval',
            ${tx.json({ generationId: input.id, designId: input.designId, version: 1 })})
        `;
        return mapGeneration(rows[0]);
      });
    },
    async markEdited(ownerId, designId) {
      const rows = await sql<GenerationDbRow[]>`
        update generation_runs set review_status = 'draft', delivery_status = 'blocked', updated_at = now()
        where owner_id = ${ownerId} and design_id = ${designId}
          and review_status <> 'draft'
        returning ${sql.unsafe(GENERATION_COLUMNS)}
      `;
      if (rows[0]) return mapGeneration(rows[0]);
      return this.findByDesign(ownerId, designId);
    },
    async submitVersion(input) {
      return sql.begin(async (tx) => {
        const locked = await tx<GenerationDbRow[]>`
          select ${tx.unsafe(GENERATION_COLUMNS)} from generation_runs
          where owner_id = ${input.ownerId} and id = ${input.generationId}
          for update
        `;
        if (!locked[0]) throw new Error("generation not found");
        const current = mapGeneration(locked[0]);
        const existing = await tx<VersionDbRow[]>`
          select generation_id as "generationId", version, document,
            document_checksum as "documentChecksum", created_by as "createdBy", created_at as "createdAt"
          from design_versions where generation_id = ${input.generationId} and version = ${current.currentVersion}
        `;
        const versionNumber = existing[0]?.documentChecksum === input.documentChecksum
          ? current.currentVersion
          : current.currentVersion + 1;
        const versions = await tx<VersionDbRow[]>`
          insert into design_versions (
            generation_id, version, owner_id, document, document_checksum, created_by
          ) values (
            ${input.generationId}, ${versionNumber}, ${input.ownerId},
            ${tx.json(jsonValue(sql, input.document))}, ${input.documentChecksum}, ${input.createdBy}
          )
          on conflict (generation_id, version) do update set
            document = excluded.document,
            document_checksum = excluded.document_checksum,
            created_by = excluded.created_by,
            created_at = now()
          returning generation_id as "generationId", version, document,
            document_checksum as "documentChecksum", created_by as "createdBy", created_at as "createdAt"
        `;
        const runs = await tx<GenerationDbRow[]>`
          update generation_runs set current_version = ${versionNumber}, review_status = 'pending',
            delivery_status = 'blocked', updated_at = now()
          where owner_id = ${input.ownerId} and id = ${input.generationId}
          returning ${tx.unsafe(GENERATION_COLUMNS)}
        `;
        await tx`
          insert into outbox_events (owner_id, generation_id, event_type, payload)
          values (${input.ownerId}, ${input.generationId}, 'generation.awaiting_approval',
            ${tx.json({ generationId: input.generationId, version: versionNumber })})
        `;
        return { generation: mapGeneration(runs[0]), version: mapVersion(versions[0]) };
      });
    },
    async recordDecision(input) {
      return sql.begin(async (tx) => {
        const status = input.action;
        const delivery = input.action === "approved" ? "available" : "blocked";
        const rows = await tx<GenerationDbRow[]>`
          update generation_runs set review_status = ${status}, delivery_status = ${delivery},
            approved_version = case when ${input.action} = 'approved' then ${input.version} else approved_version end,
            updated_at = now()
          where owner_id = ${input.ownerId} and id = ${input.generationId}
          returning ${tx.unsafe(GENERATION_COLUMNS)}
        `;
        if (!rows[0]) throw new Error("generation not found");
        const approvals = await tx<ApprovalDbRow[]>`
          insert into approvals (id, generation_id, version, owner_id, action, comment, actor_id)
          values (${randomUUID()}, ${input.generationId}, ${input.version}, ${input.ownerId},
            ${input.action}, ${input.comment ?? null}, ${input.actorId})
          returning id::text, generation_id as "generationId", version, action, comment,
            actor_id as "actorId", created_at as "createdAt"
        `;
        const eventType = `generation.${input.action}`;
        await tx`
          insert into outbox_events (owner_id, generation_id, event_type, payload)
          values (${input.ownerId}, ${input.generationId}, ${eventType},
            ${tx.json({ generationId: input.generationId, version: input.version, action: input.action, comment: input.comment ?? null })})
        `;
        const approval = approvals[0];
        return {
          generation: mapGeneration(rows[0]),
          approval: { ...approval, createdAt: approval.createdAt.toISOString() },
        };
      });
    },
    async recordMediaAsset(input) {
      await sql.begin(async (tx) => {
        await tx`
          insert into media_assets (
            id, owner_id, strategy, storage_ref, mime_type, width, height, provider,
            external_id, author, attribution_url, license_url, prompt, model
          ) values (
            ${input.id}, ${input.ownerId}, ${input.strategy}, ${input.storageRef}, ${input.mimeType},
            ${input.width}, ${input.height}, ${input.provider}, ${input.externalId}, ${input.author},
            ${input.attributionUrl}, ${input.licenseUrl}, ${input.prompt}, ${input.model}
          )
        `;
        await tx`
          insert into generation_page_assets (generation_id, version, page, layer_name, asset_id)
          values (${input.generationId}, ${input.version}, ${input.page}, ${input.layerName}, ${input.id})
        `;
      });
    },
    async recordApprovedRenders(input) {
      await sql.begin(async (tx) => {
        const owned = await tx`
          select 1 from generation_runs where id = ${input.generationId} and owner_id = ${input.ownerId}
        `;
        if (!owned[0]) throw new Error("generation not found");
        for (const render of input.renders) {
          await tx`
            insert into render_artifacts (
              generation_id, version, page, format, storage_path, checksum, approved
            ) values (
              ${input.generationId}, ${input.version}, ${render.page}, 'png',
              ${render.storagePath}, ${render.checksum}, true
            )
            on conflict (generation_id, version, page, format) do update set
              storage_path = excluded.storage_path,
              checksum = excluded.checksum,
              approved = true,
              created_at = now()
          `;
          await tx`
            update intel.art_renders set
              status = 'CONCLUIDO',
              review_status = 'approved',
              design_version = ${input.version},
              approved_at = now(),
              approved_png_url = ${render.storagePath}
            where generation_id = ${input.generationId} and page = ${render.page}
          `;
        }
      });
    },
  };
}
