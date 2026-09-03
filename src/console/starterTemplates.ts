import type { Doc, El, Page } from "../types";

/**
 * Os modelos de partida.
 *
 * "Novo design" abria um canvas em branco, e branco é ferramenta, não produto:
 * quem chega para publicar todo dia não quer uma tela vazia, quer um modelo que
 * já funciona e no qual só troca o texto. São estes que fazem a promessa dos
 * 30 segundos ser verdadeira.
 *
 * Duas regras que valem para todos, e são o que os torna um motor de template
 * em vez de um arquivo bonito:
 *
 *  1. Toda peça editável tem NOME. O nome do elemento é a superfície da API —
 *     `layers: { titulo: { text: "..." } }` no POST /api/v1/render. Um elemento
 *     sem nome é decoração, não campo, e some do playground.
 *  2. O carrossel usa OS MESMOS nomes nas três páginas. Assim o cliente da API
 *     escreve uma chamada só e varia `page` de 1 a 3 para gerar os três slides,
 *     em vez de decorar `titulo_1`, `titulo_2`, `titulo_3`.
 *
 * Molduras de imagem são um `rect` atrás do elemento `image`: o renderer pula
 * uma imagem sem `src` resolvido (editableTweetTemplate.ts), então sem o rect o
 * modelo abriria com um buraco em vez de um lugar visível para pôr a foto.
 */

const INK = "#FFFFFF";
const MUTED = "#93A4B8";
const GROUND = "#0B1220";
// Claro o bastante para ler como "põe a foto aqui" contra o GROUND. O primeiro
// valor (#16202E) sumia no fundo e o modelo abria parecendo ter um buraco.
// Só aparece enquanto a camada está vazia: o render desenha a imagem por cima.
const FRAME = "#22303F";
const ACCENT = "#1CA0F2";

function el(type: El["type"], name: string, over: Partial<El>): El {
  return {
    id: `${name}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    name,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rot: 0,
    opacity: 1,
    locked: false,
    hidden: false,
    fill: INK,
    stroke: "",
    strokeWidth: 0,
    radius: 0,
    ...over,
  };
}

const text = (name: string, over: Partial<El>): El =>
  el("text", name, { font: "Inter", align: "left", lh: 1.2, ls: 0, weight: 400, ...over });

/** Moldura + imagem nomeada, no mesmo lugar. Devolve os dois na ordem de desenho. */
function photo(name: string, box: { x: number; y: number; w: number; h: number; radius?: number }): El[] {
  return [
    el("rect", `${name}-moldura`, { ...box, fill: FRAME }),
    el("image", name, { ...box, fill: "" }),
  ];
}

function page(id: string, w: number, h: number, els: El[]): Page {
  return { id, w, h, bg: GROUND, els };
}

export interface Starter {
  /** Identifica o modelo na UI; não vai para o servidor. */
  id: "post" | "story" | "carrossel" | "automation";
  label: string;
  /** Uma linha dizendo para que serve, não que tamanho tem. */
  hint: string;
  /** Proporção da miniatura no seletor, como razão CSS. */
  ratio: string;
  sizeLabel: string;
  pages: number;
  /** Os campos que a API vai preencher — mostrados no seletor porque são a promessa do produto. */
  fields: string[];
  build: () => Doc;
}

export const STARTERS: readonly Starter[] = [
  {
    id: "post",
    label: "Post para feed",
    hint: "Foto no topo, título e assinatura. O formato que mais roda.",
    ratio: "4 / 5",
    sizeLabel: "1080 × 1350",
    pages: 1,
    fields: ["imagem", "titulo", "subtitulo", "marca"],
    build: () => ({
      name: "Post para feed",
      active: 0,
      pages: [
        page("post-1", 1080, 1350, [
          ...photo("imagem", { x: 0, y: 0, w: 1080, h: 640 }),
          text("titulo", {
            x: 72, y: 716, w: 936, h: 200,
            text: "Escreva o título aqui",
            size: 76, weight: 700, lh: 1.15,
          }),
          text("subtitulo", {
            x: 72, y: 916, w: 936, h: 140,
            text: "Uma linha de apoio explicando o post.",
            size: 36, lh: 1.45, fill: MUTED,
          }),
          text("marca", {
            x: 72, y: 1236, w: 936, h: 44,
            text: "@suamarca",
            size: 28, weight: 600, fill: ACCENT,
          }),
        ]),
      ],
    }),
  },
  {
    id: "story",
    label: "Story",
    hint: "Vertical, imagem cheia e uma chamada para ação no rodapé.",
    ratio: "9 / 16",
    sizeLabel: "1080 × 1920",
    pages: 1,
    fields: ["imagem", "titulo", "chamada"],
    build: () => ({
      name: "Story",
      active: 0,
      pages: [
        page("story-1", 1080, 1920, [
          ...photo("imagem", { x: 0, y: 0, w: 1080, h: 1160 }),
          text("titulo", {
            x: 80, y: 1270, w: 920, h: 240,
            text: "Título do story",
            size: 88, weight: 700, lh: 1.12,
          }),
          el("rect", "chamada-fundo", { x: 80, y: 1616, w: 460, h: 104, radius: 52, fill: ACCENT }),
          text("chamada", {
            x: 80, y: 1650, w: 460, h: 48,
            text: "Arrasta pra cima",
            size: 34, weight: 600, align: "center",
          }),
        ]),
      ],
    }),
  },
  {
    id: "carrossel",
    label: "Carrossel",
    hint: "Capa e dois slides. Mesmos campos nos três — a API troca só a página.",
    ratio: "4 / 5",
    sizeLabel: "1080 × 1350 · 3 páginas",
    pages: 3,
    fields: ["titulo", "texto"],
    build: () => ({
      name: "Carrossel",
      active: 0,
      pages: [
        page("carrossel-1", 1080, 1350, [
          el("rect", "faixa", { x: 72, y: 360, w: 132, h: 12, radius: 6, fill: ACCENT }),
          text("titulo", {
            x: 72, y: 432, w: 936, h: 340,
            text: "O título da sua capa",
            size: 104, weight: 700, lh: 1.08,
          }),
          text("texto", {
            x: 72, y: 840, w: 936, h: 160,
            text: "A promessa do carrossel em uma frase.",
            size: 38, lh: 1.45, fill: MUTED,
          }),
          text("rodape", {
            x: 72, y: 1236, w: 936, h: 44,
            text: "arrasta →",
            size: 28, weight: 600, fill: ACCENT,
          }),
        ]),
        page("carrossel-2", 1080, 1350, [
          text("titulo", {
            x: 72, y: 300, w: 936, h: 200,
            text: "Primeiro ponto",
            size: 72, weight: 700, lh: 1.12,
          }),
          text("texto", {
            x: 72, y: 540, w: 936, h: 460,
            text: "O texto do slide. Troque por página na chamada da API, mantendo os mesmos nomes de camada.",
            size: 40, lh: 1.5, fill: MUTED,
          }),
          text("rodape", {
            x: 72, y: 1236, w: 936, h: 44,
            text: "2 / 3",
            size: 28, weight: 600, fill: ACCENT,
          }),
        ]),
        page("carrossel-3", 1080, 1350, [
          text("titulo", {
            x: 72, y: 300, w: 936, h: 200,
            text: "Segundo ponto",
            size: 72, weight: 700, lh: 1.12,
          }),
          text("texto", {
            x: 72, y: 540, w: 936, h: 460,
            text: "Fecha com a ação que você quer que a pessoa tome.",
            size: 40, lh: 1.5, fill: MUTED,
          }),
          text("rodape", {
            x: 72, y: 1236, w: 936, h: 44,
            text: "3 / 3",
            size: 28, weight: 600, fill: ACCENT,
          }),
        ]),
      ],
    }),
  },
  {
    id: "automation",
    label: "Card para automação",
    hint: "Uma página-base que o n8n repete para cada card do roteiro.",
    ratio: "4 / 5",
    sizeLabel: "1080 × 1350",
    pages: 1,
    fields: ["titulo", "corpo", "numero", "cta"],
    build: () => ({
      name: "Card para automação",
      active: 0,
      pages: [
        page("automation-1", 1080, 1350, [
          el("rect", "marcador-fundo", { x: 72, y: 72, w: 182, h: 64, radius: 32, fill: ACCENT }),
          text("numero", {
            x: 72, y: 88, w: 182, h: 36,
            text: "1/5",
            size: 26, weight: 700, align: "center",
          }),
          text("titulo", {
            x: 72, y: 210, w: 936, h: 250,
            text: "Título do card",
            size: 84, weight: 700, lh: 1.08,
          }),
          text("corpo", {
            x: 72, y: 520, w: 936, h: 520,
            text: "Corpo do card. O n8n troca este conteúdo para cada item do roteiro.",
            size: 42, lh: 1.45, fill: MUTED,
          }),
          text("cta", {
            x: 72, y: 1194, w: 936, h: 64,
            text: "",
            size: 30, weight: 600, fill: ACCENT,
          }),
        ]),
      ],
    }),
  },
];

/** Documento em branco — continua existindo, mas como saída secundária do seletor. */
export function blankDocument(): Doc {
  return {
    name: "Design sem título",
    active: 0,
    pages: [page("pagina-1", 1080, 1350, [])],
  };
}
