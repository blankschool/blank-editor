/**
 * Lê os nomes de família de dentro de um arquivo de fonte.
 *
 * Existe por causa de uma falha silenciosa medida neste projeto: o rasterizador, quando a
 * `font-family` pedida não casa com nenhuma face carregada, NÃO erra — ele desenha com a
 * primeira fonte que estiver no banco dele. Registrar uma face declarando família "Inter"
 * quando o arquivo se chama outra coisa por dentro produz arte errada sem um único aviso, e
 * nenhuma verificação no banco ou no storage pega isso.
 *
 * A conferência tem que ser contra os bytes. É a leitura da tabela `name` do SFNT; não vale uma
 * dependência nativa nova para isso, e o parser fica trivialmente testável.
 *
 * Referência: OpenType `name` table, name IDs 1 (family) e 16 (typographic family).
 */

const NAME_ID_FAMILY = 1;
const NAME_ID_TYPOGRAPHIC_FAMILY = 16;

/** Platform 1 (Macintosh) grava 1 byte por caractere; todo o resto é UTF-16BE. */
function decodeName(bytes: Buffer, platformId: number): string {
  if (platformId === 1) return bytes.toString("latin1");
  return Buffer.from(bytes).swap16().toString("utf16le");
}

/**
 * Todos os nomes de família que este arquivo responde por. Vazio se o arquivo não for um SFNT
 * legível — quem chama decide se isso é erro.
 */
export function readFamilyNames(bytes: Buffer): string[] {
  if (bytes.length < 12) return [];
  // 'ttcf' é uma coleção: as faces têm que ter sido separadas antes de chegar aqui.
  if (bytes.toString("latin1", 0, 4) === "ttcf") return [];

  const numTables = bytes.readUInt16BE(4);
  let nameOffset = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > bytes.length) return [];
    if (bytes.toString("latin1", rec, rec + 4) === "name") {
      nameOffset = bytes.readUInt32BE(rec + 8);
      break;
    }
  }
  if (!nameOffset || nameOffset + 6 > bytes.length) return [];

  const count = bytes.readUInt16BE(nameOffset + 2);
  const stringOffset = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  const nomes = new Set<string>();
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    if (rec + 12 > bytes.length) break;
    const nameId = bytes.readUInt16BE(rec + 6);
    if (nameId !== NAME_ID_FAMILY && nameId !== NAME_ID_TYPOGRAPHIC_FAMILY) continue;
    const platformId = bytes.readUInt16BE(rec);
    const length = bytes.readUInt16BE(rec + 8);
    const offset = stringOffset + bytes.readUInt16BE(rec + 10);
    if (offset + length > bytes.length) continue;
    const valor = decodeName(bytes.subarray(offset, offset + length), platformId).replace(/\0/g, "").trim();
    if (valor) nomes.add(valor);
  }
  return [...nomes];
}

// Palavra de estilo no fim do nome -> o que ela significa. Só é cortada do nome da família quando
// o próprio arquivo (OS/2) confirma: "Arial Rounded MT Bold" declara peso 400, então "Bold" ali é
// parte do nome; "Noto Sans Old Italic" não é itálico (é o nome de uma escrita).
const STYLE_WORD_WEIGHT: Array<[RegExp, number | "italic"]> = [
  [/[\s-]+(?:Hairline|Thin)$/i, 100], [/[\s-]+(?:ExtraLight|Extra Light|UltraLight|Ultra Light)$/i, 200],
  [/[\s-]+Light$/i, 300], [/[\s-]+(?:Regular|Normal|Book|Roman)$/i, 400], [/[\s-]+Medium$/i, 500],
  [/[\s-]+(?:SemiBold|Semi Bold|DemiBold|Demi Bold|Demi)$/i, 600], [/[\s-]+(?:ExtraBold|Extra Bold|UltraBold|Ultra Bold)$/i, 800],
  [/[\s-]+Bold$/i, 700], [/[\s-]+(?:Black|Heavy)$/i, 900], [/[\s-]+(?:Italic|Oblique)$/i, "italic"],
];

/** Nome da FAMÍLIA para agrupar os pesos. Ordem (OpenType `name`): WWS family (21), typographic
 *  family (16), e por último family (1) sem o estilo no fim — só quando o OS/2 confirma que o
 *  estilo é mesmo esse. Sem isso "New Spirit Bold" (nameID 1 de muitas fontes comerciais) virava
 *  uma família separada de "New Spirit", e subir o Regular depois nunca completava o Bold. */
export function preferredFamilyName(bytes: Buffer): string | undefined {
  const nomes = readFamilyNamesById(bytes);
  if (nomes.wws) return nomes.wws;
  if (nomes.typographic) return nomes.typographic;
  let nome = nomes.family;
  if (!nome) return undefined;
  const { weight, italic } = readOs2WeightAndItalic(bytes);
  const w = normalizeWeight(weight);
  for (let i = 0; i < 3; i++) {
    const hit = STYLE_WORD_WEIGHT.find(([re, v]) => re.test(nome!) && (v === "italic" ? italic : w !== null && Math.abs(v - w) <= 50));
    if (!hit) break;
    nome = nome.replace(hit[0], "");
  }
  return nome || nomes.family;
}

/** usWeightClass: fontes antigas usam a escala 1–9 (5 = 500). Fora de 1–1000 = desconhecido. */
export function normalizeWeight(weight: number | null): number | null {
  if (weight === null || !Number.isFinite(weight)) return null;
  if (weight >= 1 && weight <= 9) return weight * 100;
  if (weight < 1 || weight > 1000) return null;
  return weight;
}

function readFamilyNamesById(bytes: Buffer): { family?: string; typographic?: string; wws?: string } {
  const out: { family?: string; typographic?: string; wws?: string } = {};
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) === "ttcf") return out;
  const numTables = bytes.readUInt16BE(4);
  let nameOffset = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > bytes.length) return out;
    if (bytes.toString("latin1", rec, rec + 4) === "name") { nameOffset = bytes.readUInt32BE(rec + 8); break; }
  }
  if (!nameOffset || nameOffset + 6 > bytes.length) return out;
  const count = bytes.readUInt16BE(nameOffset + 2);
  const stringOffset = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    if (rec + 12 > bytes.length) break;
    const nameId = bytes.readUInt16BE(rec + 6);
    if (nameId !== NAME_ID_FAMILY && nameId !== NAME_ID_TYPOGRAPHIC_FAMILY && nameId !== 21) continue;
    const length = bytes.readUInt16BE(rec + 8);
    const offset = stringOffset + bytes.readUInt16BE(rec + 10);
    if (offset + length > bytes.length) continue;
    const valor = decodeName(bytes.subarray(offset, offset + length), bytes.readUInt16BE(rec)).replace(/\0/g, "").trim();
    if (!valor) continue;
    if (nameId === NAME_ID_TYPOGRAPHIC_FAMILY) out.typographic ??= valor;
    else if (nameId === 21) out.wws ??= valor;
    else out.family ??= valor;
  }
  return out;
}

/** Caixa e espaços variam sem significar outra fonte ("Space Grotesk" / "SpaceGrotesk"). */
function normaliza(nome: string): string {
  return nome.toLowerCase().replace(/\s+/g, "");
}

/**
 * A família declarada no registro é uma das que o arquivo responde por?
 *
 * Tolerante quando o arquivo não expõe nome nenhum (tabela ilegível): melhor aceitar do que
 * recusar uma face válida — a verificação existe para pegar troca de arquivo, não para policiar
 * formato.
 */
export function familyMatchesFile(declarada: string, bytes: Buffer): { ok: boolean; noArquivo: string[] } {
  const noArquivo = readFamilyNames(bytes);
  if (!noArquivo.length) return { ok: true, noArquivo };
  const alvo = normaliza(declarada);
  return { ok: noArquivo.some((n) => normaliza(n) === alvo), noArquivo };
}

/**
 * Peso e itálico da tabela OS/2 (`usWeightClass` no offset 4, `fsSelection` no offset 62 —
 * ambos presentes desde a versão 0 da tabela). Existe para que "importar fonte" não obrigue
 * quem sobe o arquivo a digitar peso/estilo à mão: a maioria das fontes já declara isso.
 * `null`/`false` quando a tabela não existe ou é curta demais para conter esses campos — quem
 * chama decide o padrão (400/normal).
 */
export function readOs2WeightAndItalic(bytes: Buffer): { weight: number | null; italic: boolean } {
  if (bytes.length < 12) return { weight: null, italic: false };
  const numTables = bytes.readUInt16BE(4);
  let os2Offset = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > bytes.length) return { weight: null, italic: false };
    if (bytes.toString("latin1", rec, rec + 4) === "OS/2") {
      os2Offset = bytes.readUInt32BE(rec + 8);
      break;
    }
  }
  if (!os2Offset || os2Offset + 64 > bytes.length) return { weight: null, italic: false };
  const weight = bytes.readUInt16BE(os2Offset + 4);
  const fsSelection = bytes.readUInt16BE(os2Offset + 62);
  return { weight: weight > 0 ? weight : null, italic: (fsSelection & 0x01) !== 0 };
}
