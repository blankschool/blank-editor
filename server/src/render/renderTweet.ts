import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listDesignFonts, listImageLayers, pageForRender, type TemplateOverrides } from "./editableTweetTemplate.ts";
import { ensureFontFiles, type FaceRef } from "./fontCache.ts";
import { listUsedFamilies, resolveFaces } from "./resolveFonts.ts";
import { renderBrowserPng } from "./browserRender.ts";
import { applyLayerOverrides } from "./applyLayerOverrides.ts";
import { completeFontFaces } from "./completeFontFiles.ts";
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
  document = applyLayerOverrides(document, layers, pageIndex);
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
  for (const source of [doDocumento, registryFaces, builtinFaces(), completeFontFaces()]) {
    const sourceKeys = new Set<string>();
    for (const f of source) {
      const chave = `${f.family}::${f.weight}::${"style" in f ? f.style : "normal"}`;
      if (vistas.has(chave)) continue;
      sourceKeys.add(chave);
      acumuladas.push(f);
    }
    for (const key of sourceKeys) vistas.add(key);
  }
  const disponiveis = acumuladas;
  // Match the editor's per-glyph fallback. A missing character must not replace the
  // entire authored layer with Inter, changing all its widths and its appearance.
  const faces = resolveFaces(disponiveis, [...new Set([...listUsedFamilies(page), "Inter"])], true);
  const fontFiles = await ensureFontFiles(faces);

  const overrides: TemplateOverrides = { texts: layers.texts, hidden: layers.hidden };
  return renderBrowserPng(document, overrides, resolvedImages, faces, fontFiles, pageIndex);
}
