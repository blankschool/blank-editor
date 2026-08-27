import { createHash } from "node:crypto";

/** Pulls the token out of an `Authorization: Bearer <token>` header, or null if absent/malformed. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** SHA-256 hex digest of an API key — what's stored/compared in the database, never the plaintext key. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
