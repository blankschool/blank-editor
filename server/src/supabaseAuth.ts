import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Sessão do console via Supabase Auth, carregada num cookie httpOnly — nunca legível por JS no
 * navegador. Feito com o SDK "puro" do Supabase (não @supabase/ssr, que pressupõe um framework
 * como Next.js gerenciando os cookies pra você) porque este servidor é Fastify puro: aqui o
 * próprio app lê/escreve os dois cookies via @fastify/cookie, e usa o SDK só pra falar com o
 * Auth (signUp/signInWithPassword/getUser/refreshSession) — controle explícito, sem mágica de
 * framework, no mesmo espírito do resto do server (sem ORM, SQL à mão em db.ts).
 */

const ACCESS_COOKIE = "sb-access-token";
const REFRESH_COOKIE = "sb-refresh-token";

export function createSupabaseAuthClient(url: string, anonKey: string): SupabaseClient {
  // autoRefreshToken/persistSession desligados: quem guarda e renova a sessão é este servidor
  // (via cookies + /api/v1/auth/refresh), não o SDK sozinho num processo de longa duração.
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

const isProd = process.env.NODE_ENV === "production";

function cookieOpts(maxAgeSeconds: number) {
  return { httpOnly: true, secure: isProd, sameSite: "lax" as const, path: "/", maxAge: maxAgeSeconds };
}

export function setSessionCookies(reply: FastifyReply, session: { access_token: string; refresh_token: string; expires_in: number }) {
  reply.setCookie(ACCESS_COOKIE, session.access_token, cookieOpts(session.expires_in));
  reply.setCookie(REFRESH_COOKIE, session.refresh_token, cookieOpts(60 * 60 * 24 * 30)); // 30 dias
}

export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(ACCESS_COOKIE, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { path: "/" });
}

export interface SessionUser {
  ownerId: string;
  email: string;
  name: string;
}

function toSessionUser(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }): SessionUser {
  return {
    ownerId: user.id,
    email: user.email ?? "",
    name: typeof user.user_metadata?.name === "string" ? (user.user_metadata.name as string) : "",
  };
}

/** Verifica um access token do Supabase (de cookie OU de um Authorization: Bearer repassado pela Edge Function) e devolve quem é. */
export async function verifyAccessToken(client: SupabaseClient, token: string): Promise<SessionUser | null> {
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return toSessionUser(data.user);
}

/** Lê o cookie de sessão da requisição e resolve quem está logado, ou null se não houver/for inválido. */
export async function resolveSessionFromCookies(request: FastifyRequest, client: SupabaseClient): Promise<SessionUser | null> {
  const token = request.cookies[ACCESS_COOKIE];
  if (!token) return null;
  return verifyAccessToken(client, token);
}

export async function signUp(client: SupabaseClient, input: { name: string; email: string; password: string }) {
  const { data, error } = await client.auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { name: input.name } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(client: SupabaseClient, input: { email: string; password: string }) {
  const { data, error } = await client.auth.signInWithPassword({ email: input.email, password: input.password });
  if (error) throw error;
  return data;
}

export async function refreshSession(client: SupabaseClient, refreshToken: string) {
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error) throw error;
  return data;
}

export function getRefreshCookie(request: FastifyRequest): string | undefined {
  return request.cookies[REFRESH_COOKIE];
}

export function getAccessCookie(request: FastifyRequest): string | undefined {
  return request.cookies[ACCESS_COOKIE];
}
