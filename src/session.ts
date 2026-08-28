import { useSyncExternalStore } from "react";

/**
 * A identidade de quem está logado, real via Supabase Auth (fase 3 do plano de migração).
 *
 * O token de sessão mora num cookie `httpOnly` emitido pelo servidor (`POST /api/v1/auth/*`,
 * ver `server/src/supabaseAuth.ts`) — este módulo NUNCA lê o cookie diretamente (não dá: JS não
 * enxerga um cookie httpOnly). O que existe aqui é só o cache em memória de quem o servidor
 * disse que está logado, populado por `bootSession()` no boot do app (`GET /api/v1/auth/me`,
 * que o navegador manda o cookie sozinho) e atualizado por login/signup/logout.
 *
 * Isso torna a sessão inerentemente assíncrona — diferente da versão anterior (localStorage),
 * que era síncrona desde o primeiro render. Por isso existe `sessionStatus`: `router.ts` não
 * decide login-vs-console enquanto ele for `"loading"` (ver `#view-loading` em index.html).
 */
export interface Session {
  id: string;
  name: string;
  email: string;
}

export type SessionStatus = "loading" | "authenticated" | "anonymous";

let current: Session | null = null;
let status: SessionStatus = "loading";
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Para quem não é componente React (router.ts) — mesma assinatura de un-/subscribe. */
export function onSessionChange(listener: () => void): () => void {
  return subscribe(listener);
}

export function getSession(): Session | null {
  return current;
}

export function getSessionStatus(): SessionStatus {
  return status;
}

/**
 * Síncrono de propósito — é o que `router.ts` usa pra decidir a rota em cada `apply()`. Só
 * reflete a sessão de verdade depois que `bootSession()` resolveu ao menos uma vez; antes
 * disso, `sessionStatus` ainda é `"loading"` e o router nem chega a consultar isto.
 */
export function hasSession(): boolean {
  return current !== null;
}

export function setSession(session: Session): void {
  current = session;
  status = "authenticated";
  notify();
}

/**
 * Encerra a sessão de verdade no servidor (limpa os cookies httpOnly — JS não consegue fazer
 * isso sozinho) e só then limpa o cache local. Melhor esforço: mesmo se a chamada falhar
 * (rede fora do ar), o app trata como deslogado — ficar "logado" localmente sem conseguir
 * confirmar nada no servidor não ajudaria ninguém.
 */
export async function clearSession(): Promise<void> {
  try {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    /* melhor esforço — ver comentário acima */
  }
  current = null;
  status = "anonymous";
  notify();
}

/** Roda uma vez no boot do app (main.tsx) — resolve a sessão perguntando ao servidor. */
export async function bootSession(): Promise<void> {
  try {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    if (res.ok) {
      const user = await res.json();
      current = { id: user.ownerId, name: user.name, email: user.email };
      status = "authenticated";
    } else {
      current = null;
      status = "anonymous";
    }
  } catch {
    current = null;
    status = "anonymous";
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

export function useSessionStatus(): SessionStatus {
  return useSyncExternalStore(subscribe, () => status, () => status);
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
