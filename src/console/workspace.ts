/**
 * Product copy — the app's own brand, not anyone's personal data.
 *
 * This file used to also hold a hardcoded tenant name ("Studio do Miguel")
 * that the header showed regardless of who was signed in. That's gone: the
 * real signed-in identity now lives in session.ts, backed by the `workspaces`
 * table (server/schema.sql) and read via `useSession()`. What's left here is
 * exactly the stuff that's legitimately static — the product's own name and
 * tagline don't change per visitor.
 */
export const WORKSPACE = {
  brand: "Blank",
  /** A frase de produto do topo. Diz o mecanismo (desenhar) e o retorno (renderizar em escala) numa linha. */
  tagline: "Desenhe uma vez. Renderize mil vezes.",
  plan: "API inclusa",
} as const;
