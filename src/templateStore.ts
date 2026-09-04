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
