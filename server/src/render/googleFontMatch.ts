/**
 * Pergunta a um modelo de visão qual Google Font mais se parece com a fonte que um bloco de
 * texto usava no PDF original, quando o Fix 2 (canva-pdf-fonts.py) já teve que trocar aquele
 * bloco por Inter porque não conseguiu reconstruir os glifos.
 *
 * A resposta é restrita a `CANDIDATOS`: nunca um nome livre. É essa lista fixa que impede o
 * modelo de "inventar" uma fonte que depois não existe pra baixar (googleFontFetch.ts só busca
 * famílias desta lista) — sem ela, uma alucinação vira um 404 silencioso rio abaixo.
 *
 * Qualquer falha (sem chave, erro de rede, resposta fora da lista, JSON malformado) devolve um
 * Map vazio — quem chama mantém o fallback Inter que já funciona hoje. Este módulo nunca deve
 * ser motivo de um import falhar.
 */

/** Começa pela lista que o editor já carrega pro seletor de fonte (src/editor.ts) e soma nomes
 *  comuns de Google Fonts com estilo bem diferenciado — o que ajuda o modelo a escolher certo
 *  é DIVERSIDADE de forma (serifada/sans/display/script), não quantidade. */
export const CANDIDATOS_GOOGLE_FONTS = [
  "Inter", "Space Grotesk", "Montserrat", "Playfair Display", "Lora", "Oswald",
  "Bebas Neue", "DM Serif Display", "Caveat", "DM Sans", "Poppins", "Roboto",
  "Open Sans", "Nunito", "Raleway", "Work Sans", "Rubik", "Manrope", "Karla",
  "Barlow", "Archivo", "Sora", "Outfit", "Plus Jakarta Sans", "Lexend",
  "Merriweather", "PT Serif", "Libre Baskerville", "Cormorant", "Fraunces",
  "Bitter", "Anton", "League Gothic", "Josefin Sans",
  "Quicksand", "Pacifico", "Dancing Script", "Cabin", "Source Sans Pro",
] as const;

export interface FontMatchHint {
  /** "familia-estilo" que o Python guardou antes de trocar por Inter (fontOriginal). Usado só
   *  como chave de correlação da resposta — o modelo não vê esse texto, só a página. */
  chave: string;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface FontMatch {
  family: string;
  weight: number;
}

export interface GoogleFontMatchConfig {
  openAiApiKey?: string;
  model?: string;
}

type JsonFetch = (url: string, init?: RequestInit) => Promise<Response>;

const PESOS_VALIDOS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

function pesoMaisProximo(valor: number): number {
  return PESOS_VALIDOS.reduce((melhor, p) => (Math.abs(p - valor) < Math.abs(melhor - valor) ? p : melhor));
}

/** Cria o matcher. `deps.fetchJson` é injetável por teste, igual ao padrão de
 *  `createMediaAcquisitionService` em mediaAcquisition.ts. */
export function createGoogleFontMatcher(
  config: GoogleFontMatchConfig,
  deps: { fetchJson?: JsonFetch } = {},
) {
  const fetchJson = deps.fetchJson ?? fetch;

  async function match(pageImagePng: Buffer, pistas: readonly FontMatchHint[]): Promise<Map<string, FontMatch>> {
    const vazio = new Map<string, FontMatch>();
    if (!config.openAiApiKey || pistas.length === 0) return vazio;

    const prompt = [
      "Você vai olhar uma página de design e identificar, para cada bloco de texto listado, ",
      "qual fonte da lista de candidatos abaixo tem a aparência mais parecida (forma das letras, ",
      "peso visual, se é serifada/sans/display/script) com o texto naquele bloco.",
      "",
      `Candidatos (escolha SEMPRE um nome exatamente como está aqui, nunca outro): ${CANDIDATOS_GOOGLE_FONTS.join(", ")}`,
      "",
      "Blocos a identificar (chave e posição aproximada em pixels na imagem):",
      ...pistas.map((p) => `- ${p.chave}: x=${Math.round(p.bbox.x)}, y=${Math.round(p.bbox.y)}, w=${Math.round(p.bbox.w)}, h=${Math.round(p.bbox.h)}`),
      "",
      "Responda SOMENTE um JSON (sem markdown, sem texto extra) no formato:",
      '{"<chave>": {"family": "<nome da lista>", "weight": <100-900>}, ...}',
      "Se não conseguir identificar um bloco com confiança, omita a chave dele do JSON.",
    ].join("\n");

    let response: Response;
    try {
      response = await fetchJson("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openAiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model ?? "gpt-4o-mini",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/png;base64,${pageImagePng.toString("base64")}` } },
            ],
          }],
          response_format: { type: "json_object" },
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return vazio; // rede fora do ar, timeout — nunca deixa a exceção subir e derrubar o import
    }
    if (!response.ok) return vazio;

    let bruto: unknown;
    try {
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const conteudo = body.choices?.[0]?.message?.content;
      if (!conteudo) return vazio;
      bruto = JSON.parse(conteudo);
    } catch {
      return vazio; // resposta não veio no formato esperado — não é motivo de exceção subir
    }
    if (!bruto || typeof bruto !== "object") return vazio;

    const permitidas = new Set<string>(CANDIDATOS_GOOGLE_FONTS);
    const resultado = new Map<string, FontMatch>();
    for (const [chave, valor] of Object.entries(bruto as Record<string, unknown>)) {
      const family = (valor as { family?: unknown })?.family;
      const weight = Number((valor as { weight?: unknown })?.weight);
      if (typeof family !== "string" || !permitidas.has(family) || !Number.isFinite(weight)) continue;
      resultado.set(chave, { family, weight: pesoMaisProximo(weight) });
    }
    return resultado;
  }

  return { match };
}
