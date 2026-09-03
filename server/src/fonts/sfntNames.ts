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
