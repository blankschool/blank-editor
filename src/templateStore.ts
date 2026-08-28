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

export function syncTemplateToServer(doc: Doc): void {
  if (!doc.seedId) return;
  fetch(`/api/v1/templates/${doc.seedId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: doc.name, document: doc }),
  }).then((res) => { if (res.ok) emitSaved(); }).catch(() => {});
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
