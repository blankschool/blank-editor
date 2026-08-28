/**
 * Client-side "signed in" gate.
 *
 * There is no real backend session yet: server/src/auth.ts authorises the
 * render API by bearer key, not by identity, and there is no users table.
 * This module only remembers, in this browser, that someone submitted the
 * login/signup form. It is a navigation gate, not a security boundary — it
 * keeps console and editor from being reachable by just typing a hash, but
 * anyone can still fake it via localStorage. Real accounts (e-mail + server
 * session, workspace no longer a constant in console/workspace.ts) are a
 * separate, bigger piece of work; this is the interim shape that at least
 * stops silent access without going through the form.
 */
export interface Session {
  email: string;
}

const KEY = "blank-editor-session";

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.email === "string" && parsed.email.trim() ? { email: parsed.email } : null;
  } catch {
    return null;
  }
}

export function hasSession(): boolean {
  return getSession() !== null;
}

export function setSession(email: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ email }));
  } catch {
    /* blocked storage — the gate just won't persist across reloads */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* blocked storage */
  }
}
