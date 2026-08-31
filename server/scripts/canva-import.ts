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

interface Manifest {
  templateName: string;
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

async function uploadLayer(buffer: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: "image/png" }), filename);
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
  const document = { name: manifest.templateName, active: 0, pages };

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
