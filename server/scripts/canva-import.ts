/**
 * Termina de montar um template do Blank Editor a partir de um design do Canva já extraído.
 *
 * A extração em si (isolar cada camada zerando a opacidade de tudo mais, exportar, repetir) só
 * é possível pelo conector MCP do Canva dentro de uma sessão do Claude — não existe API pública
 * equivalente (ver a seção "Importar designs do Canva" do plano). Este script cuida só da parte
 * determinística de código: reconstrói a transparência de cada camada de imagem já exportada,
 * recorta pra caixa do elemento, sobe pro bucket privado `uploads` (nunca base64 embutido no
 * JSON — é o antipadrão que o protótipo original tinha) e cria o template pela própria API,
 * usando a chave de API do dono, do mesmo jeito que qualquer outro cliente (n8n, Playground).
 *
 * Uso: node scripts/canva-import.ts <manifesto.json>
 * Env: BLANK_EDITOR_API_URL (default http://127.0.0.1:8787), BLANK_EDITOR_API_KEY (obrigatória).
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { processLayer, processLayerDual, type Bbox, type CapturedOver } from "../src/canvaImport/pipeline.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverEnvPath = resolve(scriptDir, "..", ".env");
if (existsSync(serverEnvPath)) process.loadEnvFile(serverEnvPath);

const API_URL = process.env.BLANK_EDITOR_API_URL ?? "http://127.0.0.1:8787";
const API_KEY = process.env.BLANK_EDITOR_API_KEY;

interface ManifestImageElementSingle {
  type: "image";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rawFile: string;
  capturedOver: CapturedOver | null;
  [key: string]: unknown;
}

/** Vem da extração via PDF (`pdfSource.ts`), não de um render isolado de página inteira — o
 *  arquivo já é exatamente o pixel final (recorte de moldura via `cropForFrame`, ou composição
 *  já correta via `combineWithSoftMask`). Sobe direto, sem passar por `processLayer`/
 *  `cropToBBox` — que assumem um render do tamanho da página e quebram num arquivo já pronto. */
interface ManifestImageElementPrecropped {
  type: "image";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rawFile: string;
  precropped: true;
  [key: string]: unknown;
}

/** Duas exportações da mesma camada isolada (uma sobre branco, outra sobre preto) — recupera
 *  alpha E cor originais de verdade (`processLayerDual`), em vez de assumir preto/branco. Use
 *  pra fotos de verdade; `rawFile`+`capturedOver` continua valendo pra conteúdo de cor única
 *  (um logo/texto branco, por exemplo), onde a aproximação de uma captura já é exata. */
interface ManifestImageElementDual {
  type: "image";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rawFileWhite: string;
  rawFileBlack: string;
  [key: string]: unknown;
}

type ManifestImageElement = ManifestImageElementSingle | ManifestImageElementDual | ManifestImageElementPrecropped;

function isDualCapture(el: ManifestImageElement): el is ManifestImageElementDual {
  return "rawFileWhite" in el && "rawFileBlack" in el;
}

function isPrecropped(el: ManifestImageElement): el is ManifestImageElementPrecropped {
  return "precropped" in el && (el as ManifestImageElementPrecropped).precropped === true;
}

interface ManifestOtherElement {
  type: "text" | "rect" | "ellipse" | "triangle" | "star" | "line" | "icon" | "draw";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  [key: string]: unknown;
}

type ManifestElement = ManifestImageElement | ManifestOtherElement;

interface ManifestPage {
  w: number;
  h: number;
  bg: string;
  elements: ManifestElement[];
}

/** Uma face reconstruída por `canva-pdf-fonts.py` — o fonts.json que ele grava é exatamente
 *  uma lista disto, então o manifesto só precisa apontar para a pasta. */
interface ManifestFont {
  arquivo: string;
  familia: string;
  estilo: string;
  peso: number;
  sha256: string;
  postscript_name?: string;
  stretch?: string;
  os2_fs_type?: number;
  texto?: string;
}

interface Manifest {
  templateName: string;
  /** Pasta com os .woff2/.ttf + fonts.json, relativa ao manifesto. Ausente = design que só
   *  usa fontes do app, e aí não há nada para subir. */
  fontsDir?: string;
  pages: ManifestPage[];
}

/** Campos que todo `El` do Blank Editor exige (src/types.ts) e que o manifesto não precisa
 *  repetir toda vez — o manifesto pode sobrescrever qualquer um passando o campo direto. */
function withElementDefaults(el: ManifestElement): Record<string, unknown> {
  const {
    rawFile: _rawFile,
    capturedOver: _capturedOver,
    rawFileWhite: _rawFileWhite,
    rawFileBlack: _rawFileBlack,
    precropped: _precropped,
    ...rest
  } = el as ManifestImageElementSingle & ManifestImageElementDual & ManifestImageElementPrecropped;
  return {
    id: randomUUID(),
    rot: 0,
    opacity: 1,
    locked: false,
    hidden: false,
    fill: "",
    stroke: "",
    strokeWidth: 0,
    radius: 0,
    ...rest,
  };
}

function isImageElement(el: ManifestElement): el is ManifestImageElement {
  return el.type === "image";
}

/** O caminho via PDF (`canva-pdf-extract.ts`) entrega a camada no encoding original — uma foto
 *  de fundo continua JPEG, só quem tem alfa vira PNG. Rotular tudo como PNG gravava o
 *  content-type errado no bucket, e é ele que o navegador recebe ao abrir o design no editor. */
function contentTypeOf(filename: string): string {
  return /\.jpe?g$/i.test(filename) ? "image/jpeg" : "image/png";
}

/**
 * Sobe as fontes que o design carrega consigo e devolve o `Doc.fonts`.
 *
 * Elas precisam ir para o mesmo lugar que o documento: a arte usa AniconSans/NYTFranklin, que
 * não existem no navegador de quem abre o design nem no container que renderiza. Enquanto
 * ficavam commitadas em public/fonts e server/fonts, cada PDF novo exigia commit e redeploy
 * das duas imagens — e um design importado num ambiente ficava sem fonte no outro.
 */
async function uploadFonts(manifestDir: string, fontsDir: string) {
  const dir = resolve(manifestDir, fontsDir);
  const faces = JSON.parse(readFileSync(resolve(dir, "fonts.json"), "utf8")) as ManifestFont[];
  return Promise.all(
    faces.map(async (face) => {
      const registrada = await registerFontFace(dir, face);
      if (face.os2_fs_type && face.os2_fs_type & 0x000e) {
        console.warn(`  aviso: ${face.familia} ${face.estilo} tem fsType 0x${face.os2_fs_type.toString(16).padStart(4, "0")} ` +
          `(embedding restrito) — registrada, mas confira a licença antes de publicar.`);
      }
      return {
        family: face.familia,
        weight: face.peso,
        sha256: registrada.sha256,
        ttf: registrada.sfntPath,
        woff2: registrada.woff2Path,
        glyphs: face.texto,
      };
    }),
  );
}

/** Sobe os dois formatos da face e registra no banco, numa chamada só (POST /api/v1/fonts). O
 *  servidor recalcula o sha256 a partir dos bytes; o que vai aqui é só descritivo. */
async function registerFontFace(dir: string, face: ManifestFont) {
  const form = new FormData();
  const [sfnt, woff2] = await Promise.all([
    readFile(resolve(dir, `${face.arquivo}.ttf`)),
    readFile(resolve(dir, `${face.arquivo}.woff2`)),
  ]);
  form.append("sfnt", new Blob([new Uint8Array(sfnt)], { type: "font/ttf" }), `${face.arquivo}.ttf`);
  form.append("woff2", new Blob([new Uint8Array(woff2)], { type: "font/woff2" }), `${face.arquivo}.woff2`);
  form.append("internalFamily", face.familia);
  form.append("weight", String(face.peso));
  form.append("style", face.estilo);
  if (face.postscript_name) form.append("postscriptName", face.postscript_name);
  if (face.stretch) form.append("stretch", face.stretch);
  if (face.os2_fs_type !== undefined) form.append("os2FsType", String(face.os2_fs_type));

  const res = await fetch(`${API_URL}/api/v1/fonts`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`registro da fonte ${face.arquivo} falhou: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; sha256: string; sfntPath: string; woff2Path: string };
}

async function uploadLayer(buffer: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: contentTypeOf(filename) }), filename);
  const res = await fetch(`${API_URL}/api/v1/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload de ${filename} falhou: ${res.status} ${await res.text()}`);
  const { src } = (await res.json()) as { src: string };
  return src;
}

async function buildPage(manifestDir: string, page: ManifestPage) {
  const canvas = { width: page.w, height: page.h };
  const els = await Promise.all(
    page.elements.map(async (el) => {
      if (!isImageElement(el)) return withElementDefaults(el);

      const bbox: Bbox = { left: el.x, top: el.y, width: el.w, height: el.h };
      let processed: Buffer;
      let filenameForUpload: string;
      if (isPrecropped(el)) {
        processed = await readFile(resolve(manifestDir, el.rawFile));
        filenameForUpload = el.rawFile;
      } else if (isDualCapture(el)) {
        const [overWhite, overBlack] = await Promise.all([
          readFile(resolve(manifestDir, el.rawFileWhite)),
          readFile(resolve(manifestDir, el.rawFileBlack)),
        ]);
        processed = await processLayerDual({ overWhite, overBlack, bbox, canvas });
        filenameForUpload = el.rawFileWhite;
      } else {
        const raw = await readFile(resolve(manifestDir, el.rawFile));
        processed = await processLayer({ raw, capturedOver: el.capturedOver, bbox, canvas });
        filenameForUpload = el.rawFile;
      }
      const src = await uploadLayer(processed, filenameForUpload);
      return { ...withElementDefaults(el), src };
    }),
  );
  return { id: randomUUID(), w: page.w, h: page.h, bg: page.bg, els };
}

async function main() {
  if (!API_KEY) {
    console.error("BLANK_EDITOR_API_KEY não definida (server/.env ou env do processo).");
    process.exit(1);
  }
  const manifestArg = process.argv[2];
  if (!manifestArg) {
    console.error("uso: node scripts/canva-import.ts <manifesto.json>");
    process.exit(1);
  }

  const manifestPath = resolve(manifestArg);
  const manifestDir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  const pages = await Promise.all(manifest.pages.map((page) => buildPage(manifestDir, page)));
  const fonts = manifest.fontsDir ? await uploadFonts(manifestDir, manifest.fontsDir) : undefined;
  const document = { name: manifest.templateName, active: 0, pages, ...(fonts?.length ? { fonts } : {}) };
  if (fonts?.length) console.log(`fontes: ${fonts.map((f) => `${f.family} ${f.weight}`).join(", ")}`);

  const res = await fetch(`${API_URL}/api/v1/templates`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ name: manifest.templateName, document }),
  });
  if (!res.ok) throw new Error(`criação do template falhou: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  console.log(`template criado: ${id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
