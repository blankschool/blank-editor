export interface PlaygroundApiKeyDeps {
  read: (ownerId: string) => string | null;
  save: (ownerId: string, secret: string) => void;
  create: () => Promise<string>;
}

/** Resolves the key shown by the Playground for one account in this browser. */
export async function ensurePlaygroundApiKey(ownerId: string, deps: PlaygroundApiKeyDeps): Promise<string> {
  const cached = deps.read(ownerId);
  if (cached) return cached;

  const secret = await deps.create();
  if (!secret) throw new Error("API key creation returned an empty secret");
  deps.save(ownerId, secret);
  return secret;
}
