import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FaceRef } from "./fontCache.ts";
import { DEFAULT_FONT_FAMILY } from "./editableTweetTemplate.ts";

/**
 * As faces que acompanham o servidor, sempre disponíveis para qualquer render.
 *
 * Existem por causa de um modo de falha concreto: `DEFAULT_FONT_FAMILY` é "Inter", todo
 * elemento de texto sem fonte explícita pede essa família, e nada garantia que ela existisse.
 * O rasterizador roda com `loadSystemFonts: false` (de propósito — ver fontCache.ts), então
 * "Inter" só resolvia se a CONTA tivesse subido um Inter no registro de fontes ou se o
 * documento declarasse a face. Resultado: renderizar o mesmo design dava certo numa conta e
 * 400 noutra —
 *
 *   "o documento usa a família "Inter" mas não declara nenhuma face para ela em Doc.fonts"
 *
 * — que é o erro que os templates iniciais produziam, já que nenhum deles declara fontes.
 *
 * Embutir os arquivos troca "depende do que a conta subiu" por "vem com o servidor". Os bytes
 * são versionados junto com o código, então o mesmo commit desenha igual em qualquer máquina
 * e em qualquer conta — a mesma propriedade que fez o rasterizador recusar fonte do sistema.
 *
 * Prioridade é a MENOR das três: documento > registro da conta > embutida. Quem declara a
 * face no documento continua mandando; isto é só o piso, para não haver render impossível.
 *
 * Inter, SIL Open Font License 1.1 — ver Inter-LICENSE.txt nesta pasta.
 */

const aqui = dirname(fileURLToPath(import.meta.url));

function face(arquivo: string, weight: number): FaceRef {
  const caminho = join(aqui, "fonts", arquivo);
  // sha256 calculado dos bytes reais, não fixado no código: `ensureFontFiles` confere o hash
  // do que leu contra este valor, então uma constante escrita à mão viraria erro de render se
  // o arquivo fosse atualizado. Derivar do arquivo mantém os dois em sincronia por construção.
  const sha256 = createHash("sha256").update(readFileSync(caminho)).digest("hex");
  // `src` absoluto: readSource() em fontCache.ts lê caminho absoluto direto do disco, sem rede
  // nem storage — que é o que permite a estas faces funcionarem num container isolado.
  return { family: DEFAULT_FONT_FAMILY, weight, sha256, src: caminho };
}

/** Lazy: ler e hashear no import encareceria o boot mesmo para quem nunca renderiza. */
let cache: FaceRef[] | null = null;

export function builtinFaces(): FaceRef[] {
  cache ??= [
    face("Inter-Light.ttf", 300),
    face("Inter-Regular.ttf", 400),
    face("Inter-Medium.ttf", 500),
    face("Inter-SemiBold.ttf", 600),
    face("Inter-Bold.ttf", 700),
    face("Inter-ExtraBold.ttf", 800),
  ];
  return cache;
}
