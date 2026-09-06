import type { Doc } from "./types.ts";

const STORAGE_PREFIX = "blank-editor-template-";

function emitSaved() {
  try {
    window.dispatchEvent(new CustomEvent("blank-editor-saved"));
  } catch { /* non-browser */ }
}

export function saveTemplateLocally(doc: Doc): void {
  if (!doc.seedId) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + doc.seedId, JSON.stringify(doc));
    emitSaved();
  } catch { /* quota or blocked storage */ }
}

export function loadTemplateLocally(id: string): Doc | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.seedId === id && Array.isArray(parsed.pages) ? (parsed as Doc) : null;
  } catch {
    return null;
  }
}

export async function syncTemplateToServer(doc: Doc): Promise<boolean> {
  if (!doc.seedId) return true;
  try {
    const res = await fetch(`/api/v1/templates/${doc.seedId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: doc.name, document: doc }),
    });
    if (!res.ok) return false;
    emitSaved();
    return true;
  } catch {
    return false;
  }
}

export async function fetchTemplateFromServer(id: string): Promise<Doc> {
  const res = await fetch(`/api/v1/templates/${id}`);
  if (!res.ok) throw new Error(`template not found: ${id}`);
  const body = await res.json();
  return { ...(body.document as Doc), name: body.name, seedId: id };
}

export interface TemplateSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export async function listTemplatesFromServer(): Promise<TemplateSummary[]> {
  const res = await fetch("/api/v1/templates");
  if (!res.ok) throw new Error("failed to list templates");
  return res.json();
}

export async function createTemplateOnServer(name: string, document: Doc): Promise<string> {
  const res = await fetch("/api/v1/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, document }),
  });
  if (!res.ok) throw new Error("failed to create template");
  const { id } = await res.json();
  return id as string;
}

export async function deleteTemplateOnServer(id: string): Promise<void> {
  const res = await fetch(`/api/v1/templates/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("failed to delete template");
}

/* ------------------------- histórico de versão ------------------------- */

export interface DesignVersionSummary {
  id: string;
  name: string;
  createdAt: string;
}

export async function listDesignVersionsFromServer(templateId: string): Promise<DesignVersionSummary[]> {
  const res = await fetch(`/api/v1/templates/${templateId}/versions`);
  if (!res.ok) throw new Error("failed to list versions");
  return res.json();
}

export async function createDesignVersionOnServer(templateId: string, name: string): Promise<DesignVersionSummary> {
  const res = await fetch(`/api/v1/templates/${templateId}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("failed to create version");
  return res.json();
}

export async function restoreDesignVersionOnServer(templateId: string, versionId: string): Promise<void> {
  const res = await fetch(`/api/v1/templates/${templateId}/versions/${versionId}/restore`, { method: "POST" });
  if (!res.ok) throw new Error("failed to restore version");
}

export async function duplicateDesignVersionOnServer(templateId: string, versionId: string): Promise<string> {
  const res = await fetch(`/api/v1/templates/${templateId}/versions/${versionId}/duplicate`, { method: "POST" });
  if (!res.ok) throw new Error("failed to duplicate version");
  const { id } = await res.json();
  return id as string;
}

export async function deleteDesignVersionOnServer(templateId: string, versionId: string): Promise<void> {
  const res = await fetch(`/api/v1/templates/${templateId}/versions/${versionId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("failed to delete version");
}

export interface DesignVersionDocument {
  name: string;
  document: Doc;
}

export async function fetchDesignVersionDocument(templateId: string, versionId: string): Promise<DesignVersionDocument> {
  const res = await fetch(`/api/v1/templates/${templateId}/versions/${versionId}`);
  if (!res.ok) throw new Error("failed to fetch version");
  const body = await res.json();
  return { name: body.name, document: body.document as Doc };
}

/* ----------------------------- compartilhar ----------------------------- */

export interface ShareStatus {
  visibility: "private" | "link";
  publicUrl: string | null;
}

export async function getShareStatus(templateId: string): Promise<ShareStatus> {
  const res = await fetch(`/api/v1/templates/${templateId}/share`);
  if (!res.ok) throw new Error("failed to get share status");
  return res.json();
}

export async function setShareVisibility(templateId: string, visibility: "private" | "link"): Promise<ShareStatus> {
  const res = await fetch(`/api/v1/templates/${templateId}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visibility }),
  });
  if (!res.ok) throw new Error("failed to set share visibility");
  return res.json();
}

/* --------------------- comentários fixados no canvas (item 4.3) --------------------- */

export interface DesignCommentReply {
  id: string;
  commentId: string;
  ownerId: string;
  body: string;
  createdAt: string;
}

export interface DesignComment {
  id: string;
  templateId: string;
  ownerId: string;
  pageIndex: number;
  x: number;
  y: number;
  body: string;
  resolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
  replies: DesignCommentReply[];
}

export async function listCommentsFromServer(templateId: string): Promise<DesignComment[]> {
  const res = await fetch(`/api/v1/templates/${templateId}/comments`);
  if (!res.ok) throw new Error("failed to list comments");
  return res.json();
}

export async function createCommentOnServer(
  templateId: string,
  input: { pageIndex: number; x: number; y: number; body: string },
): Promise<DesignComment> {
  const res = await fetch(`/api/v1/templates/${templateId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("failed to create comment");
  return res.json();
}

export async function setCommentResolvedOnServer(templateId: string, commentId: string, resolved: boolean): Promise<void> {
  const res = await fetch(`/api/v1/templates/${templateId}/comments/${commentId}/${resolved ? "resolve" : "reopen"}`, { method: "POST" });
  if (!res.ok) throw new Error("failed to update comment");
}

export async function deleteCommentOnServer(templateId: string, commentId: string): Promise<void> {
  const res = await fetch(`/api/v1/templates/${templateId}/comments/${commentId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("failed to delete comment");
}

export async function replyToCommentOnServer(templateId: string, commentId: string, body: string): Promise<DesignCommentReply> {
  const res = await fetch(`/api/v1/templates/${templateId}/comments/${commentId}/replies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error("failed to reply to comment");
  return res.json();
}

/* ------------------ painel de design system/marca (item 4.7) ------------------ */
// POR CONTA, não por design — por isso as rotas não levam templateId, diferente de tudo acima.

export interface BrandKit {
  id: string;
  ownerId: string;
  name: string;
  colors: string[];
  fonts: string[];
  createdAt: string;
}

export async function listBrandKitsFromServer(): Promise<BrandKit[]> {
  const res = await fetch("/api/v1/brand-kits");
  if (!res.ok) throw new Error("failed to list brand kits");
  return res.json();
}

export async function createBrandKitOnServer(name: string, colors: string[], fonts: string[]): Promise<BrandKit> {
  const res = await fetch("/api/v1/brand-kits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, colors, fonts }),
  });
  if (!res.ok) throw new Error("failed to create brand kit");
  return res.json();
}

export async function deleteBrandKitOnServer(id: string): Promise<void> {
  const res = await fetch(`/api/v1/brand-kits/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("failed to delete brand kit");
}
