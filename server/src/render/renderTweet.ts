import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderAsync } from "@resvg/resvg-js";
import { buildTemplateSvg, listDesignFonts, listImageLayers, pageForRender, type TemplateOverrides } from "./editableTweetTemplate.ts";
import { ensureFontFiles, type FaceRef } from "./fontCache.ts";
import { assertGlyphCoverage, elementsWithGlyphFallback, listUsedFamilies, resolveFaces } from "./resolveFonts.ts";
import { builtinFaces } from "./builtinFaces.ts";
import { fetchImage } from "./imageSource.ts";
import { PRIVATE_UPLOAD_PREFIX, fetchPrivateUpload } from "../storage.ts";
import type { ParsedLayers } from "./layers.ts";

/**
 * O cliente Storage é configurado uma vez no boot (server.ts), quando um projeto Supabase
 * está presente — sem ele, uma referência `supabase://uploads/...` simplesmente não resolve
 * (o layer fica sem imagem, como já acontecia pra qualquer src inválido). Módulo-nível em vez
 * de mais um parâmetro encadeado por AppDeps/app.ts porque é um recurso singleton por
 * deployment, não algo que varia por request.
 */
let storageClient: SupabaseClient | null = null;
export function configureStorageClient(client: SupabaseClient | null): void {
  storageClient = client;
}

async function toDataUrl(url: string): Promise<string> {
  const raw = url.startsWith(PRIVATE_UPLOAD_PREFIX)
    ? await (async () => {
        if (!storageClient) throw new Error("private upload referenced, but no Storage client is configured");
        return fetchPrivateUpload(storageClient, url);
      })()
    : await fetchImage(url);
  const png = await sharp(raw).png().toBuffer(); // normalize whatever format was fetched to PNG
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * Renders a template document to PNG. Fetches (SSRF-guarded) whatever image layers need it:
 * a request override first, then — for any image layer not overridden or hidden — the URL the
 * template itself was saved with, if that's a plain http(s) URL rather than an embedded data URI.
 */
export async function renderTemplatePng(
  document: unknown,
  layers: ParsedLayers,
  pageIndex?: number,
  /**
   * Faces que o DONO tem registradas, para as famílias que o documento usa mas não declara.
   *
   * Um design importado de PDF carrega as fontes dele em `Doc.fonts`. Um template comum não
   * carrega nada — ele só diz `font: "Inter"` e conta que Inter exista. Sem esta lista, semear
   * o registry não adiantaria nada: o render nunca olharia para lá, e todo template do app
   * falharia por família não declarada.
   *
   * O documento tem precedência: uma face declarada nele descreve AQUELE design e não deve ser
   * trocada por outra versão que o dono tenha registrado depois.
   */
  registryFaces: readonly FaceRef[] = [],
): Promise<Buffer> {
  const toFetch: Record<string, string> = {};
  for (const [name, url] of Object.entries(layers.images)) {
    if (!layers.hidden.has(name)) toFetch[name] = url;
  }
  // As imagens buscadas têm que ser as DESTA página: um carrossel com foto
  // diferente por slide baixaria a foto errada se olhássemos sempre a capa.
  for (const { name, src } of listImageLayers(document, pageIndex)) {
    if (layers.hidden.has(name) || toFetch[name]) continue;
    if (src && (/^https?:\/\//i.test(src) || src.startsWith(PRIVATE_UPLOAD_PREFIX))) toFetch[name] = src;
  }

  const fetched = await Promise.all(
    Object.entries(toFetch).map(async ([name, url]) => [name, await toDataUrl(url)] as const),
  );
  const resolvedImages = Object.fromEntries(fetched);

  // As fontes desta página, em disco, antes de rasterizar. Só as famílias que a página usa —
  // e falha alto se alguma não estiver declarada (resolveFonts.ts).
  const page = pageForRender(document, pageIndex);
  const doDocumento = listDesignFonts(document);
  // Precedência: documento > registro da conta > embutida. A chave família::peso é o que
  // define "já tenho esta face" — a primeira fonte a declarar um par vence, e as camadas de
  // baixo só preenchem buraco. Assim quem declara a face no design continua no controle, e as
  // embutidas (builtinFaces.ts) garantem apenas que a família padrão nunca falte.
  const acumuladas: FaceRef[] = [];
  const vistas = new Set<string>();
  for (const f of [...doDocumento, ...registryFaces, ...builtinFaces()]) {
    const chave = `${f.family}::${f.weight}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    acumuladas.push(f);
  }
  const disponiveis = acumuladas;
  const facesDeclaradas = resolveFaces(disponiveis, listUsedFamilies(page));
  // Um subset vindo de PDF não cobre o alfabeto inteiro: qualquer camada de texto cuja face
  // declarada não tenha os glifos pedidos passa a pedir Inter (completa) em vez da família
  // original — troca o ELEMENTO, não só o arquivo carregado, porque o resvg casa font-family
  // pelo nome que o arquivo declara por dentro (ver elementsWithGlyphFallback).
  const elsAjustados = elementsWithGlyphFallback(page, layers.texts, facesDeclaradas, builtinFaces());
  const pageAjustada = { ...page, els: elsAjustados };
  const faces = resolveFaces(disponiveis, listUsedFamilies(pageAjustada));
  // Rede de segurança final: se nem a substituta cobrir o texto, ainda recusamos em vez de
  // desenhar em branco.
  assertGlyphCoverage(pageAjustada, layers.texts, faces);
  const fontFiles = await ensureFontFiles(faces);

  // O SVG precisa nascer da página AJUSTADA (com os fallbacks de fonte já aplicados), não da
  // original — por isso troca a página correspondente dentro de uma cópia do documento em vez
  // de passar `document` direto para buildTemplateSvg.
  const paginas = (document as { pages?: unknown[] })?.pages;
  const indice = Array.isArray(paginas) ? paginas.indexOf(page) : -1;
  const documentoParaSvg = indice >= 0
    ? { ...(document as object), pages: paginas!.map((p, i) => (i === indice ? pageAjustada : p)) }
    : document;

  const overrides: TemplateOverrides = { texts: layers.texts, hidden: layers.hidden };
  const svg = buildTemplateSvg(documentoParaSvg, overrides, resolvedImages, pageIndex);

  // resvg, não sharp/librsvg, para desenhar o SVG.
  //
  // Duas razões, as duas medidas nesta migração. (1) O librsvg resolve fonte pelo fontconfig do
  // PROCESSO, que lê a configuração uma vez e ignora mudanças — não há como entregar a ele uma
  // fonte que chegou junto com o documento. O resvg monta um banco de fontes por renderização a
  // partir dos arquivos que recebe. (2) O librsvg era o desalinhado: no mesmo SVG e com a mesma
  // fonte, ele posiciona `dominant-baseline="text-before-edge"` de 6 a 31px acima do Chrome,
  // enquanto o resvg bate com o navegador em 0-1px. Trocar aproximou o render do canvas do
  // editor, em vez de afastar.
  // `renderAsync`, não `new Resvg(...).render()`: a versão síncrona rasteriza no thread do Node
  // e trava o event loop do Fastify pelo tempo do desenho — numa página de 1080x1440 com fotos,
  // tempo suficiente para segurar todas as outras requisições.
  const png = await renderAsync(svg, { font: { fontFiles, loadSystemFonts: false } });
  return sharp(png.asPng()).png().toBuffer();
}
