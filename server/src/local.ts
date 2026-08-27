import { hashApiKey } from "./auth.ts";
import type { AppDeps } from "./app.ts";

/** In-memory dependencies for local development; production continues to use Postgres. */
export function createLocalDeps(apiKey: string, renderTweetPng: AppDeps["renderTweetPng"]): AppDeps {
  const allowedHash = hashApiKey(apiKey);
  return {
    findApiKeyOwner: async (keyHash) =>
      keyHash === allowedHash ? { id: "local", name: "local development" } : null,
    findTemplate: async (id, kind) =>
      id === "tweet-screenshot" && kind === "tweet"
        ? { id: "tweet-screenshot", kind: "tweet", name: "Twitter mínimo" }
        : null,
    renderTweetPng,
  };
}
