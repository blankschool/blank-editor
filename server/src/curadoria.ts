import type { Sql } from "./db.ts";

/**
 * Busca na curadoria (schema `intel`) por tema.
 *
 * Existe porque o n8n roda em OUTRO servidor e o Postgres do Supabase não é exposto
 * publicamente — o fluxo `gerar-conteudo` não consegue consultar `intel.*` direto. Em vez de
 * duplicar a query dentro de um nó do n8n (onde ela não é versionada nem testável), ela mora
 * aqui e o n8n chama por HTTP com a mesma chave de API de sempre.
 *
 * O match é contra TÓPICOS (`intel.topics`), não contra posts soltos: a curadoria já agrega
 * menções por tópico e calcula tendência diária por grupo (`intel.trends_daily` →
 * `intel.v_trending_assunto`), então casar por tópico traz junto o sinal de recência e
 * engajamento. Os posts vêm depois, como REFERÊNCIA do que aquele tópico rendeu na prática
 * (`intel.topic_mentions` → `intel.v_content_full`).
 */

/** Sem `unaccent` instalado no banco (conferido), então dobra de acento é feita à mão — tanto
 *  aqui quanto no SQL, com a MESMA tabela de caracteres, senão os dois lados normalizam
 *  diferente e o match silenciosamente erra. */
const COM_ACENTO = "áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ";
const SEM_ACENTO = "aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC";

/** Palavras que casariam com quase todo tópico e só sujariam o resultado — medido: com "para"
 *  na lista, o tema "finanças para iniciantes" trazia posts sobre vulcão e STF. */
const STOPWORDS = new Set([
  "para", "com", "que", "dos", "das", "uma", "uns", "como", "pelo", "pela", "por", "nos", "nas",
  "sobre", "entre", "seus", "suas", "mais", "meu", "minha", "este", "esta", "isso", "aos", "num",
  "numa", "the", "and", "de", "da", "do", "em", "no", "na", "ao", "os", "as", "um",
]);

/** Só tokens com 4+ caracteres viram critério: abaixo disso o ruído domina (ver STOPWORDS). */
const TAMANHO_MINIMO_TOKEN = 4;

/** Abaixo disto o match é fraco demais pra servir de referência (só uma palavra solta batendo
 *  na descrição do tópico). É o que separa "achei referências" de `needs_external_research`. */
export const SCORE_MINIMO = 40;

/** Quantos tópicos distintos podem alimentar as referências de uma busca. Mais de um porque um
 *  tema amplo ("STF") se espalha em vários tópicos vizinhos na curadoria. */
const MAX_TOPICOS = 3;

/** Teto de posts por perfil, pra não devolver 5 posts do mesmo veículo como se fossem cinco
 *  referências distintas (requisito: diversificar perfis). */
const MAX_POR_PERFIL = 2;

export function normalizarTema(tema: string): string {
  let saida = "";
  for (const ch of tema.trim().toLowerCase()) {
    const i = COM_ACENTO.indexOf(ch);
    saida += i === -1 ? ch : SEM_ACENTO[i];
  }
  return saida;
}

export function tokensDoTema(tema: string): string[] {
  return normalizarTema(tema)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= TAMANHO_MINIMO_TOKEN && !STOPWORDS.has(t));
}

/**
 * Handle sempre com exatamente um "@". A coluna `intel.contents.handle` já guarda o arroba, mas
 * quem consome (o n8n, a UI) tende a acrescentar outro por conta própria — foi assim que saiu
 * "@@estadao" na resposta do webhook. Normalizar aqui é o que garante que os dois lados possam
 * ser idempotentes sem combinarem nada entre si.
 */
export function normalizarPerfil(handle: string): string {
  return `@${handle.trim().replace(/^@+/, "")}`;
}

export interface TendenciaTopico {
  mencoes7d: number;
  perfisDistintos: number;
  engajamento7d: number;
  scoreMedio: number;
}

export interface TopicoCuradoria {
  topicId: string;
  slug: string;
  label: string;
  /** `assunto` (tema principal do post) ou `subtema` — ver `intel.topics.nivel`. */
  nivel: string | null;
  totalMencoes: number;
  ultimaVez: string | null;
  score: number;
  tendencia: TendenciaTopico | null;
}

export interface ReferenciaCuradoria {
  perfil: string;
  nomeExibicao: string | null;
  postId: string;
  permalink: string | null;
  formato: string | null;
  grupo: string | null;
  nicho: string | null;
  categoria: string | null;
  funil: string | null;
  temaDetectado: string | null;
  subtemas: string[];
  resumo: string | null;
  legenda: string | null;
  publicadoEm: string | null;
}

export interface ResultadoCuradoria {
  topicos: TopicoCuradoria[];
  referencias: ReferenciaCuradoria[];
}

/** `translate` em vez de `unaccent`: a extensão não está instalada neste banco, e criar uma
 *  extensão nova num Postgres compartilhado por vários projetos é mais invasivo do que
 *  dobrar acento na mão. */
function semAcento(coluna: string): string {
  return `lower(translate(coalesce(${coluna}, ''), '${COM_ACENTO}', '${SEM_ACENTO}'))`;
}

/**
 * Escala de score do match de TÓPICO (documentada porque é o critério pedido na especificação):
 *   100 — label ou slug do tópico é exatamente o tema
 *    80 — label/slug contém o tema inteiro
 *  0-60 — proporcional: `60 * (tokens que batem / tokens do tema)`
 *
 * A proporção existe por um falso positivo medido: com "algum token basta", o tema "rotina
 * matinal de skincare" casava com o tópico "rotina de alimentação" (um post sobre cachorro) só
 * porque a palavra "rotina" aparecia — 1 token de 3. Com a proporção, 1/3 dá 20 e fica abaixo
 * do corte; só passa quem bate o tema quase inteiro.
 *
 * Empate desempata por tendência (score médio dos últimos 7 dias) e depois por recência —
 * entre dois tópicos igualmente parecidos com o tema, o que está bombando agora vale mais.
 */
export async function buscarCuradoriaPorTema(
  sql: Sql,
  tema: string,
  limiteReferencias = 5,
): Promise<ResultadoCuradoria> {
  const alvo = normalizarTema(tema);
  const tokens = tokensDoTema(tema);
  if (!alvo) return { topicos: [], referencias: [] };

  const topicos = await sql.unsafe(
    `
    with pontuado as (
      select
        t.id, t.slug, t.label, t.nivel, t.total_mencoes, t.ultima_vez, t.descricao,
        greatest(
          case when ${semAcento("t.label")} = $1 or ${semAcento("t.slug")} = $1 then 100 else 0 end,
          case when ${semAcento("t.label")} like '%' || $1 || '%'
                 or ${semAcento("t.slug")} like '%' || $1 || '%' then 80 else 0 end,
          case when cardinality($2::text[]) = 0 then 0 else round(
            60.0 * (
              select count(*) from unnest($2::text[]) tk
              where ${semAcento("t.label")} like '%' || tk || '%'
                 or ${semAcento("t.slug")} like '%' || tk || '%'
                 or ${semAcento("t.descricao")} like '%' || tk || '%'
            )::numeric / cardinality($2::text[])
          ) end
        ) as score
      from intel.topics t
    )
    select
      p.id, p.slug, p.label, p.nivel, p.total_mencoes, p.ultima_vez, p.score,
      v.mencoes_7d, v.perfis_distintos, v.engajamento_7d, v.score_medio
    from pontuado p
    left join intel.v_trending_assunto v on v.topic_id = p.id and v.grupo = 'todos'
    where p.score >= $3
    order by p.score desc, coalesce(v.score_medio, 0) desc, p.ultima_vez desc nulls last
    limit $4
    `,
    [alvo, tokens, SCORE_MINIMO, MAX_TOPICOS],
  ) as any[];

  if (topicos.length === 0) return { topicos: [], referencias: [] };

  const ids = topicos.map((t) => t.id);
  const referencias = await sql.unsafe(
    `
    with posts as (
      select
        c.id, c.handle, c.display_name, c.permalink, c.formato, c.grupo, c.nicho,
        c.categoria, c.funil, c.assunto, c.subtemas, c.resumo, c.caption, c.published_at,
        max(m.peso) as peso,
        row_number() over (partition by c.handle order by max(m.peso) desc, c.published_at desc) as pos_no_perfil
      from intel.topic_mentions m
      join intel.v_content_full c on c.id = m.content_id
      where m.topic_id = any($1::uuid[])
      group by c.id, c.handle, c.display_name, c.permalink, c.formato, c.grupo, c.nicho,
               c.categoria, c.funil, c.assunto, c.subtemas, c.resumo, c.caption, c.published_at
    )
    select * from posts
    where pos_no_perfil <= $2
    order by peso desc nulls last, published_at desc
    limit $3
    `,
    [ids, MAX_POR_PERFIL, limiteReferencias],
  ) as any[];

  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);

  return {
    topicos: topicos.map((t) => ({
      topicId: t.id,
      slug: t.slug,
      label: t.label,
      nivel: t.nivel ?? null,
      totalMencoes: Number(t.total_mencoes ?? 0),
      ultimaVez: iso(t.ultima_vez),
      score: Number(t.score),
      tendencia: t.mencoes_7d === null || t.mencoes_7d === undefined ? null : {
        mencoes7d: Number(t.mencoes_7d),
        perfisDistintos: Number(t.perfis_distintos ?? 0),
        engajamento7d: Number(t.engajamento_7d ?? 0),
        scoreMedio: Number(t.score_medio ?? 0),
      },
    })),
    referencias: referencias.map((r) => ({
      perfil: normalizarPerfil(r.handle),
      nomeExibicao: r.display_name ?? null,
      postId: r.id,
      permalink: r.permalink ?? null,
      formato: r.formato ?? null,
      grupo: r.grupo ?? null,
      nicho: r.nicho ?? null,
      categoria: r.categoria ?? null,
      funil: r.funil ?? null,
      temaDetectado: r.assunto ?? null,
      subtemas: Array.isArray(r.subtemas) ? r.subtemas : [],
      resumo: r.resumo ?? null,
      legenda: r.caption ?? null,
      publicadoEm: iso(r.published_at),
    })),
  };
}
