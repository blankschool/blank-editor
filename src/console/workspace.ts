/**
 * Identidade do workspace.
 *
 * Está num arquivo só, e é constante, porque o servidor ainda não tem conceito
 * de usuário nem de conta: não existe tabela de users, o login não autentica
 * nada e a API de render se autoriza por chave, não por sessão. Fingir um nome
 * vindo do backend seria pior que assumir um — quando houver `GET /api/v1/me`,
 * é este módulo que troca de implementação, e nada mais.
 */
export const WORKSPACE = {
  brand: "Blank",
  name: "Studio do Miguel",
  /** A frase de produto do topo. Diz o mecanismo (desenhar) e o retorno (renderizar em escala) numa linha. */
  tagline: "Desenhe uma vez. Renderize mil vezes.",
  plan: "API inclusa",
} as const;

/** Iniciais para o avatar — sem foto, o nome do workspace é a única fonte. */
export function workspaceInitials(): string {
  return WORKSPACE.name
    .split(/\s+/)
    .filter((word) => word.length > 2) // descarta "do", "de", "da"
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}
