import { createHash } from "node:crypto";

export type ProcessingStatus = "queued" | "acquiring_media" | "rendering" | "ready" | "failed" | "canceled";
export type ReviewStatus = "draft" | "pending" | "changes_requested" | "approved" | "rejected";
export type DeliveryStatus = "blocked" | "available" | "downloaded" | "failed";
export type ApprovalAction = "approved" | "changes_requested" | "rejected";

export interface GenerationRun {
  id: string;
  ownerId: string;
  designId: string;
  sourceTemplateId: string;
  idempotencyKey: string;
  requestHash: string;
  processingStatus: ProcessingStatus;
  reviewStatus: ReviewStatus;
  deliveryStatus: DeliveryStatus;
  currentVersion: number;
  approvedVersion: number | null;
  runId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesignVersion {
  generationId: string;
  version: number;
  document: unknown;
  documentChecksum: string;
  createdBy: string | null;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  generationId: string;
  version: number;
  action: ApprovalAction;
  comment: string | null;
  actorId: string;
  createdAt: string;
}

export interface MediaAssetRecord {
  id: string;
  ownerId: string;
  generationId: string;
  version: number;
  page: number;
  layerName: string;
  strategy: "stock" | "ai";
  storageRef: string;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  externalId: string | null;
  author: string | null;
  attributionUrl: string | null;
  licenseUrl: string | null;
  prompt: string | null;
  model: string | null;
  createdAt: string;
}

export interface CreateGenerationInput {
  id: string;
  ownerId: string;
  designId: string;
  sourceTemplateId: string;
  idempotencyKey: string;
  requestHash: string;
  runId?: string | null;
  document: unknown;
  documentChecksum: string;
  createdBy?: string | null;
}

export interface SubmitVersionInput {
  ownerId: string;
  generationId: string;
  document: unknown;
  documentChecksum: string;
  createdBy: string;
}

export interface GenerationRepository {
  findByIdempotency(ownerId: string, idempotencyKey: string): Promise<GenerationRun | null>;
  findById(ownerId: string, generationId: string): Promise<GenerationRun | null>;
  findByDesign(ownerId: string, designId: string): Promise<GenerationRun | null>;
  findVersion(ownerId: string, generationId: string, version: number): Promise<DesignVersion | null>;
  createWithInitialVersion(input: CreateGenerationInput): Promise<GenerationRun>;
  markEdited(ownerId: string, designId: string): Promise<GenerationRun | null>;
  submitVersion(input: SubmitVersionInput): Promise<{ generation: GenerationRun; version: DesignVersion }>;
  recordDecision(input: {
    ownerId: string;
    generationId: string;
    version: number;
    action: ApprovalAction;
    comment?: string | null;
    actorId: string;
  }): Promise<{ generation: GenerationRun; approval: ApprovalRecord }>;
  recordMediaAsset(input: Omit<MediaAssetRecord, "createdAt">): Promise<void>;
  recordApprovedRenders(input: {
    ownerId: string;
    generationId: string;
    version: number;
    renders: Array<{ page: number; storagePath: string; checksum: string }>;
  }): Promise<void>;
}

/** JSON can arrive with a different object-key order through n8n. Idempotency is about
 * semantic request identity, so hashes use a recursively sorted representation. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createMemoryGenerationRepository(): GenerationRepository {
  const generations = new Map<string, GenerationRun>();
  const versions = new Map<string, DesignVersion>();
  const approvals: ApprovalRecord[] = [];
  const media: MediaAssetRecord[] = [];
  const key = (ownerId: string, generationId: string) => `${ownerId}\0${generationId}`;
  const versionKey = (ownerId: string, generationId: string, version: number) => `${key(ownerId, generationId)}\0${version}`;
  const now = () => new Date().toISOString();

  return {
    async findByIdempotency(ownerId, idempotencyKey) {
      return [...generations.values()].find((item) => item.ownerId === ownerId && item.idempotencyKey === idempotencyKey) ?? null;
    },
    async findById(ownerId, generationId) {
      return generations.get(key(ownerId, generationId)) ?? null;
    },
    async findByDesign(ownerId, designId) {
      return [...generations.values()].find((item) => item.ownerId === ownerId && item.designId === designId) ?? null;
    },
    async findVersion(ownerId, generationId, version) {
      return versions.get(versionKey(ownerId, generationId, version)) ?? null;
    },
    async createWithInitialVersion(input) {
      const duplicate = [...generations.values()].find((item) =>
        item.ownerId === input.ownerId && item.idempotencyKey === input.idempotencyKey);
      if (duplicate) throw new Error("generation idempotency key already exists");
      const timestamp = now();
      const run: GenerationRun = {
        id: input.id,
        ownerId: input.ownerId,
        designId: input.designId,
        sourceTemplateId: input.sourceTemplateId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        processingStatus: "ready",
        reviewStatus: "pending",
        deliveryStatus: "blocked",
        currentVersion: 1,
        approvedVersion: null,
        runId: input.runId ?? null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      generations.set(key(input.ownerId, input.id), run);
      versions.set(versionKey(input.ownerId, input.id, 1), {
        generationId: input.id,
        version: 1,
        document: structuredClone(input.document),
        documentChecksum: input.documentChecksum,
        createdBy: input.createdBy ?? null,
        createdAt: timestamp,
      });
      return run;
    },
    async markEdited(ownerId, designId) {
      const run = [...generations.values()].find((item) => item.ownerId === ownerId && item.designId === designId);
      if (!run) return null;
      const updated = { ...run, reviewStatus: "draft" as const, deliveryStatus: "blocked" as const, updatedAt: now() };
      generations.set(key(ownerId, run.id), updated);
      return updated;
    },
    async submitVersion(input) {
      const run = generations.get(key(input.ownerId, input.generationId));
      if (!run) throw new Error("generation not found");
      const current = versions.get(versionKey(input.ownerId, run.id, run.currentVersion));
      const versionNumber = current?.documentChecksum === input.documentChecksum ? run.currentVersion : run.currentVersion + 1;
      const timestamp = now();
      const version: DesignVersion = {
        generationId: run.id,
        version: versionNumber,
        document: structuredClone(input.document),
        documentChecksum: input.documentChecksum,
        createdBy: input.createdBy,
        createdAt: timestamp,
      };
      versions.set(versionKey(input.ownerId, run.id, versionNumber), version);
      const updated = {
        ...run,
        currentVersion: versionNumber,
        reviewStatus: "pending" as const,
        deliveryStatus: "blocked" as const,
        updatedAt: timestamp,
      };
      generations.set(key(input.ownerId, run.id), updated);
      return { generation: updated, version };
    },
    async recordDecision(input) {
      const run = generations.get(key(input.ownerId, input.generationId));
      if (!run) throw new Error("generation not found");
      const timestamp = now();
      const approval: ApprovalRecord = {
        id: `${input.generationId}-${input.version}-${approvals.length + 1}`,
        generationId: input.generationId,
        version: input.version,
        action: input.action,
        comment: input.comment ?? null,
        actorId: input.actorId,
        createdAt: timestamp,
      };
      approvals.push(approval);
      const updated: GenerationRun = {
        ...run,
        reviewStatus: input.action === "approved" ? "approved" : input.action,
        deliveryStatus: input.action === "approved" ? "available" : "blocked",
        approvedVersion: input.action === "approved" ? input.version : run.approvedVersion,
        updatedAt: timestamp,
      };
      generations.set(key(input.ownerId, run.id), updated);
      return { generation: updated, approval };
    },
    async recordMediaAsset(input) {
      media.push({ ...input, createdAt: now() });
    },
    async recordApprovedRenders() {},
  };
}
