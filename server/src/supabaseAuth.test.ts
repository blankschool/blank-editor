import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseAuthClient, refreshSession } from "./supabaseAuth.ts";

test("simultaneous refreshes for different users never share a Supabase SDK session", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { refresh_token } = JSON.parse(String(options?.body));
    calls.push(refresh_token);
    await new Promise(resolve => setTimeout(resolve, 15));
    const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
    const token = `${encode({ alg: "HS256" })}.${encode({ sub: refresh_token, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
    return new Response(JSON.stringify({ access_token: token, refresh_token: `${refresh_token}-next`, expires_in: 3600, token_type: "bearer", user: { id: refresh_token, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01" } }), { headers: { "Content-Type": "application/json" } });
  });
  const client = createSupabaseAuthClient("https://auth.test", "test-anon-key");
  const [a, b] = await Promise.all([refreshSession(client, "user-a"), refreshSession(client, "user-b")]);
  assert.equal(a.session?.refresh_token, "user-a-next");
  assert.equal(b.session?.refresh_token, "user-b-next");
  assert.deepEqual(calls.sort(), ["user-a", "user-b"]);
});
