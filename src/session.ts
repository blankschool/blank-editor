import { useSyncExternalStore } from "react";

/**
 * The signed-in identity, real now.
 *
 * `Session` is exactly the `workspaces` row the server returns from
 * POST /api/v1/workspace (signup) or GET /api/v1/workspace/by-email/:email
 * (login) — see server/schema.sql and server/src/app.ts. This module does not
 * invent any of it; it only caches that row in this browser (localStorage) so
 * console/editor don't refetch it on every navigation, and re-renders whoever
 * reads it via `useSession()` the moment login/signup or "Sair" changes it.
 *
 * What this still is NOT: a server session. There's no cookie, no token, no
 * expiry — `router.ts`'s gate just checks "is there a cached workspace row",
 * and LoginApp.tsx's "senha" field is validated for length only, never checked
 * against anything. Anyone with devtools can paste a fake row into
 * localStorage and pass the gate. Real server sessions are separate, larger
 * work; this module's honesty about the boundary is deliberate — see the
 * comment on the `workspaces` table in schema.sql for why a password check
 * isn't bundled in here "for free".
 */
export interface Session {
  id: string;
  name: string;
  email: string;
}

const KEY = "blank-editor-session";

function readFromStorage(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === "string" && typeof parsed?.name === "string" && typeof parsed?.email === "string"
      ? { id: parsed.id, name: parsed.name, email: parsed.email }
      : null;
  } catch {
    return null;
  }
}

let current: Session | null = readFromStorage();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSession(): Session | null {
  return current;
}

export function hasSession(): boolean {
  return current !== null;
}

export function setSession(session: Session): void {
  current = session;
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* blocked storage — the gate just won't persist across reloads */
  }
  notify();
}

export function clearSession(): void {
  current = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* blocked storage */
  }
  notify();
}

/**
 * Reactive read for React components. Needed because ConsoleApp mounts once
 * and never unmounts (the router only toggles `display`) — a plain function
 * call at render time would freeze whatever session existed when the app
 * booted, and the header would keep showing nobody right after a successful
 * login on the very same page.
 */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Initials for the avatar — first letter of up to two words, skipping short connectors ("do", "de", "da"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 2);
  const source = words.length > 0 ? words : name.trim().split(/\s+/);
  return source
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}
