import { fetchImage } from "./render/imageSource.ts";

/**
 * A busca do banco de imagens do painel "Imagens" — navegar e escolher, não acertar de primeira.
 *
 * `mediaAcquisition.ts` já fala com o Pexels, mas para outra coisa: ele recebe um tema e devolve
 * UMA foto já normalizada, porque quem chama é a geração automática de um layer, que não tem
 * ninguém olhando. O painel precisa do oposto — uma página de resultados com miniatura, para a
 * pessoa escolher — então os dois compartilham o provedor e nada mais.
 *
 * A chave nunca chega ao navegador. Ela é lida só aqui, no servidor (`PEXELS_API_KEY`), como as
 * outras chaves deste repositório (ver docs/import-fonts.md); o editor conversa com as rotas
 * `/api/v1/stock/*` e nunca com api.pexels.com.
 */

export interface StockPhoto {
  id: string;
  width: number;
  height: number;
  /** Miniatura para a grade do painel. */
  thumb: string;
  /** Descrição da foto, quando o Pexels tem uma — vira o alt da miniatura. */
  alt: string;
  photographer: string;
  /** A página da foto no Pexels. A licença pede crédito ao autor com link de volta. */
  pageUrl: string;
}

export interface StockPhotoPage {
  photos: StockPhoto[];
  /** Existe mais página depois desta? O painel só mostra "carregar mais" quando existe. */
  hasMore: boolean;
}

export interface StockPhotoLibrary {
  search(query: string, options?: { page?: number; orientation?: string }): Promise<StockPhotoPage>;
  /** Os bytes da foto escolhida — o editor recebe do NOSSO domínio, não do CDN do Pexels. */
  file(id: string): Promise<{ bytes: Buffer; contentType: string }>;
}

type JsonFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface PexelsPhoto {
  id: number;
  width?: number;
  height?: number;
  alt?: string;
  url?: string;
  photographer?: string;
  src?: { original?: string; large2x?: string; large?: string; medium?: string; tiny?: string };
}

const ORIENTACOES = new Set(["landscape", "portrait", "square"]);
const PER_PAGE = 24;

function normalizar(photo: PexelsPhoto): StockPhoto | null {
  const thumb = photo.src?.medium ?? photo.src?.tiny ?? photo.src?.large;
  if (!photo.id || !thumb) return null;
  return {
    id: String(photo.id),
    width: Number(photo.width) || 0,
    height: Number(photo.height) || 0,
    thumb,
    alt: (photo.alt || "").trim(),
    photographer: (photo.photographer || "").trim(),
    pageUrl: photo.url || "",
  };
}

export function createStockPhotoLibrary(
  apiKey: string,
  deps: { fetchJson?: JsonFetch; fetchImageBytes?: (url: string) => Promise<Buffer> } = {},
): StockPhotoLibrary {
  const fetchJson = deps.fetchJson ?? fetch;
  const fetchImageBytes = deps.fetchImageBytes ?? fetchImage;

  async function pexels(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`https://api.pexels.com/v1/${path}`);
    for (const [chave, valor] of Object.entries(params)) url.searchParams.set(chave, valor);
    const response = await fetchJson(url.toString(), {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Pexels ${path} respondeu ${response.status}`);
    return response.json();
  }

  return {
    async search(query, options = {}) {
      const termo = query.trim();
      if (!termo) return { photos: [], hasMore: false };
      // `page` vem da query string, então pode ser qualquer coisa: fixar o piso em 1 evita
      // mandar `page=0` ou `page=-3` para o Pexels e receber um erro em vez de uma página.
      const page = Math.max(1, Math.trunc(Number(options.page)) || 1);
      const body = await pexels("search", {
        query: termo,
        per_page: String(PER_PAGE),
        page: String(page),
        locale: "pt-BR",
        ...(options.orientation && ORIENTACOES.has(options.orientation) ? { orientation: options.orientation } : {}),
      }) as { photos?: PexelsPhoto[]; next_page?: string };
      const photos = (body.photos ?? []).map(normalizar).filter((p): p is StockPhoto => p !== null);
      return { photos, hasMore: Boolean(body.next_page) };
    },

    async file(id) {
      if (!/^\d+$/.test(id)) throw new Error("id de foto inválido");
      const body = await pexels(`photos/${id}`) as PexelsPhoto;
      // `large2x` em vez de `original`: o original de uma foto do Pexels passa fácil de 10 MB, e
      // a imagem vai ser embutida no documento — o editor guarda imagem como data URL.
      const source = body.src?.large2x ?? body.src?.large ?? body.src?.original;
      if (!source) throw new Error("a foto não trouxe nenhuma URL de imagem");
      return { bytes: await fetchImageBytes(source), contentType: "image/jpeg" };
    },
  };
}
