import "./styles.css";
import { editorTextHtml, textRunsHtml, fitTextElements, curveGeometry, type TextFx } from "../server/src/render/editorText";
import { replaceTemplateText } from "../server/src/render/replacementFonts.ts";
import {
  FONT_CATEGORIES, catalogStylesheetUrls, designFamilies, fontLabel, localFontFaceCss, searchFontLibrary,
  type FontCategory,
} from "./fontLibrary.ts";
import { loadDesignFonts } from "./designFontLoader";
import { fetchGlobalFonts, registeredDocFont, withGlobalFontFamily, type RegisteredFontFace } from "./globalFontLibrary.ts";
import { b64ToBytes, buildPDF } from "./pdf";
import { buildZip } from "./zip";
import type { Doc, DocFont, El, Page } from "./types";
import { cropToBackgroundStyle, cropToSourceRect } from "./imageCrop";
import { copyStyle, distribute, pasteStyle, toggleBullets, type CopiedStyle } from "./editorActions.ts";
import { applyFontToOriginal, familyKey, missingPdfFonts, missingWeights } from "./missingFonts.ts";
import { applyStyleToRange, rangeEvery, runsFromPieces, type StyleOverride } from "./richText";
import { createTweetTemplateDocument, TWEET_TEMPLATE_ID } from "./tweetTemplateDoc";
import {
  fetchTemplateFromServer, loadTemplateLocally, saveTemplateLocally, syncTemplateToServer, createTemplateOnServer, deleteTemplateOnServer,
  listDesignVersionsFromServer, createDesignVersionOnServer, restoreDesignVersionOnServer, duplicateDesignVersionOnServer, deleteDesignVersionOnServer,
  fetchDesignVersionDocument, getShareStatus, setShareVisibility, type DesignVersionSummary, type ShareStatus,
  listCommentsFromServer, createCommentOnServer, setCommentResolvedOnServer, deleteCommentOnServer, replyToCommentOnServer,
  type DesignComment,
  listBrandKitsFromServer, createBrandKitOnServer, deleteBrandKitOnServer, type BrandKit,
} from "./templateStore";
import { relativeTime } from "./console/relativeTime.ts";
import { pageOffset, pageAtY, zoomedPanY, verticalBounds } from "./editorViewport";
import { draggedLayerIds, reorderLayers, type LayerDropSide } from "./layerOrder";
import { attachLayerDrag } from "./layerDrag";
import { dedupeLayerNames, uniqueLayerName } from "../server/src/render/layerNames.ts";
import { canGroupElements, canUngroupElements, groupElements, ungroupElements } from "./elementGroups";

declare global {
  interface Window {
    claude?: { use(name: string): Promise<any> };
    __nudge?: ReturnType<typeof setTimeout>;
    blankEditor?: unknown;
  }
}

/**
 * The editor core. Still one module on purpose: doc/sel/tool/zoom and friends
 * are read and written by nearly every function here, so splitting it further
 * is a refactor to do behind the fidelity tests, not before them.
 */

const $ = (id: string): any => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const PAGE_SIZES = [
  { n: "Post", w: 1080, h: 1080 }, { n: "Post 4:5", w: 1080, h: 1350 }, { n: "Story", w: 1080, h: 1920 },
  { n: "Slide", w: 1920, h: 1080 }, { n: "A4", w: 794, h: 1123 },
  { n: "Capa", w: 1200, h: 630 }, { n: "Cartão", w: 1050, h: 600 },
];
const TYPE_PT = { rect: "Retângulo", ellipse: "Elipse", triangle: "Triângulo", star: "Estrela", line: "Linha", text: "Texto", image: "Imagem", icon: "Ícone", draw: "Desenho" };
const PT_ALIGN = { justify: "justificado", left: "à esquerda", center: "ao centro", cx: "ao centro", right: "à direita", top: "ao topo", cy: "ao meio", bottom: "à base" };
const PALETTE = ["#FFFFFF", "#F3F5F7", "#E3E8ED", "#CBD5DD", "#8296A1", "#4E636E", "#2A3A45", "#131C26"];
const STAGE_BG_PRESETS = ["#000000", "#181F25", "#2A3A45", "#4E636E", "#8296A1", "#CBD5DD", "#E3E8ED", "#F3F5F7"];

/* ============================ state ============================ */
const blankPage = () => ({ id: uid(), w: 1080, h: 1080, bg: "#000000", els: [] });
const SEED: Doc = { name: "Design sem título", pages: [blankPage()], active: 0 } as Doc;
let doc: Doc = SEED;
let sel: string[] = [];
let tool = "select";
/* comentários fixados no canvas (item 4.3) */
let commentsData: DesignComment[] = [];
/** Enquanto true, o PRÓXIMO clique numa página fixa um comentário ali em vez de fazer o que um
 *  clique normal faria (selecionar/desmarcar/marquee) — ver o topo do handler de pointerdown do
 *  #stage. Não é um `tool` de verdade (não tem botão próprio na barra, nem estado persistente)
 *  porque é sempre "um clique só", desarmado de novo assim que usado ou cancelado. */
let placingComment = false;
/* painel de design system/marca (item 4.7) — por conta, não por design, ver templateStore.ts */
let brandKits: BrandKit[] = [];
let zoom = 1, panX = 0, panY = 0;
// The workspace behind the page — separate from the page's own "Fundo" fill (that's the
// artboard's content; this is just the room around it). Remembered per-browser, not per-doc.
// null means "no explicit choice": the stage falls back to --ground in styles.css, which
// follows the light/dark theme. An explicit pick pins the colour across both themes.
const STAGE_BG_KEY = "blank-editor-stage-bg";
let stageBg: string | null = (() => { try { return localStorage.getItem(STAGE_BG_KEY); } catch { return null; } })();
function stageGroundHex() {
  const v = getComputedStyle($("view-editor")).getPropertyValue("--ground").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#E3E8ED";
}
function applyStageBg() {
  $("stage").style.background = stageBg ?? "";
  try {
    if (stageBg) localStorage.setItem(STAGE_BG_KEY, stageBg);
    else localStorage.removeItem(STAGE_BG_KEY);
  } catch { /* blocked storage */ }
}
let past: string[] = [], future: string[] = [];
let clipboard = null;
let editingId = null;
let lastClickId: string | null = null;
let lastClickTime = 0;
// Keep the position/layers inspector open across selection and history changes.
let propPopOpen = false;
let ratioLock = false;
let layerFilter: "all" | "overlap" = "all";
let panelTab: "organize" | "layers" | "code" | "effects" = "organize";
let ctxMenuOpen = false;
let activeTab: string | null = null;
let fitView = true;
const imgCache = new Map<string, HTMLImageElement>();

// Keep enough screen space for page controls even when the artwork is zoomed out.
function pageTop(i: number): number {
  return pageOffset(doc.pages, i, zoom);
}
function stackHeight(): number {
  return doc.pages.length ? pageTop(doc.pages.length - 1) + doc.pages[doc.pages.length - 1].h : 0;
}
function stackWidth(): number {
  return doc.pages.reduce((m, p) => Math.max(m, p.w), 0);
}
/** Which page a world Y falls into — the gap between pages splits down the middle. */
function pageIndexAtWorldY(y: number): number {
  return pageAtY(doc.pages, y, zoom);
}

/** How far past the document's own edges the view may travel. A little air, never a plane. */
const VIEW_MARGIN = 56;
/** The one rule that makes this a document and not an infinite canvas: the page column always
 * stays in the viewport. On each axis, a stack that fits the stage is pinned to the centre —
 * it cannot be nudged off it at all; only once the stack outgrows the stage does travel open
 * up, and then just far enough to reach both edges plus VIEW_MARGIN of air. Every mutation of
 * panX/panY/zoom must end here — without it, a zoom-out strands the pages in the grey. */
function clampView() {
  const s = $("stage").getBoundingClientRect();
  const docH = stackHeight() * zoom, docW = stackWidth() * zoom;
  const cx = (s.width - docW) / 2;
  const bounds = verticalBounds(docH, s.height, VIEW_MARGIN);
  panY = clamp(panY, bounds.min, bounds.max);
  panX = docW <= s.width
    ? cx
    : clamp(panX, s.width - docW - VIEW_MARGIN, VIEW_MARGIN);
}
const page = (): Page => doc.pages[clamp(doc.active, 0, doc.pages.length - 1)];
/** Elements are looked up across every page, not just the active one — with the stack always
 * visible, the current selection can be (and dragging can land) on any page. */
function locate(id: string): { pageIdx: number; el: El } | null {
  for (let i = 0; i < doc.pages.length; i++) {
    const el = doc.pages[i].els.find((e) => e.id === id);
    if (el) return { pageIdx: i, el };
  }
  return null;
}
const byId = (id: string): El | undefined => locate(id)?.el;
const pageIdxOf = (id: string): number => locate(id)?.pageIdx ?? doc.active;
const selEls = () => sel.map(byId).filter(Boolean);
// Images live once in doc.assets; elements point at them with "@key" so the
// same photo used on several slides is stored a single time.
const rawSrcOf = (e) => (e.src && e.src[0] === "@" ? (doc.assets && doc.assets[e.src.slice(1)]) || "" : e.src || "");

// A `src` starting with this prefix is a private-bucket reference, not a URL — the browser has
// no service-role key to fetch it directly (only the server's render pipeline can). Resolve it
// to a short-lived signed URL first; while that's in flight, srcOf returns "" (the existing
// "no src yet" placeholder box), and renderCanvas() re-runs once the real URL lands.
const PRIVATE_UPLOAD_PREFIX = "supabase://uploads/";
const PRIVATE_SRC_TTL_MS = 4 * 60 * 1000;
const resolvedPrivateSrc = new Map<string, { url: string; expiresAt: number }>();
const resolvingPrivateSrc = new Set<string>();
function resolvePrivateSrc(ref: string): string {
  const cached = resolvedPrivateSrc.get(ref);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  if (cached) resolvedPrivateSrc.delete(ref);
  if (!resolvingPrivateSrc.has(ref)) {
    resolvingPrivateSrc.add(ref);
    fetch(`/api/v1/uploads/resolve?ref=${encodeURIComponent(ref)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(({ url }) => { resolvedPrivateSrc.set(ref, { url, expiresAt: Date.now() + PRIVATE_SRC_TTL_MS }); resolvingPrivateSrc.delete(ref); renderCanvas(); })
      .catch(() => { resolvingPrivateSrc.delete(ref); });
  }
  return "";
}
/** Fundo da página em CSS: imagem (cobrindo) sobre degradê/cor. */
/** Pontas de linha: a linha é uma barra de espessura `h`; a ponta tem ~3× a espessura. */
function lineEndPath(kind: string, x: number, cy: number, t: number, dir: 1 | -1): string {
  const L = t * 3, W = t * 2.2;
  if (kind === "circle") return `M${x - dir * W / 2},${cy} a${W / 2},${W / 2} 0 1,0 ${dir * W},0 a${W / 2},${W / 2} 0 1,0 ${-dir * W},0`;
  if (kind === "bar") return `M${x - dir * t / 2},${cy - W} h${dir * t} v${W * 2} h${-dir * t} Z`;
  if (kind === "arrow") return `M${x - dir * L},${cy - W} L${x},${cy} L${x - dir * L},${cy + W} L${x - dir * (L - t * 1.2)},${cy} Z`;
  return `M${x - dir * L},${cy - W} L${x},${cy} L${x - dir * L},${cy + W} Z`;
}
function lineGeom(e: any) {
  const t = e.h, cy = e.h / 2;
  const inset = (k?: string) => (k === "arrow" || k === "triangle" ? t * 2.4 : 0);
  return { t, cy, x0: inset(e.arrowStart), x1: e.w - inset(e.arrowEnd) };
}
function lineSvg(e: any): string {
  const { t, cy, x0, x1 } = lineGeom(e);
  const ends = [e.arrowStart ? lineEndPath(e.arrowStart, 0, cy, t, -1) : "", e.arrowEnd ? lineEndPath(e.arrowEnd, e.w, cy, t, 1) : ""].join(" ");
  return `<svg viewBox="0 0 ${e.w} ${e.h}" style="width:100%;height:100%;overflow:visible"><rect x="${x0}" y="0" width="${Math.max(0, x1 - x0)}" height="${t}" rx="${e.arrowStart && e.arrowEnd ? 0 : t / 2}" fill="${e.fill}"/><path d="${ends}" fill="${e.fill}"/></svg>`;
}
function pageBgCss(p: Page): string {
  const base = p.bgGrad ? gradToCss(p.bgGrad) : p.bg;
  const img = p.bgImage ? srcOf({ src: p.bgImage }) : "";
  return img ? `url('${img}') center/cover no-repeat, ${base}` : base;
}
const BG_GRADS: Array<[string, string, number]> = [
  ["#ff9a9e", "#fad0c4", 135], ["#a18cd1", "#fbc2eb", 135], ["#84fab0", "#8fd3f4", 120], ["#f6d365", "#fda085", 120],
  ["#0f2027", "#2c5364", 160], ["#232526", "#414345", 180], ["#fc466b", "#3f5efb", 90], ["#11998e", "#38ef7d", 90],
];
const srcOf = (e) => {
  const raw = rawSrcOf(e);
  return raw.startsWith(PRIVATE_UPLOAD_PREFIX) ? resolvePrivateSrc(raw) : raw;
};


/* ============================ history ============================ */
const snap = () => JSON.stringify({ d: doc, s: sel });
// `baseline` is the last committed state. commit() must push the state as it
// was BEFORE the current mutation, otherwise the first undo is a no-op.
let baseline = snap();
function commit() {
  // Ponto único onde duplicar, colar ou renomear uma camada vira estado salvo — e o único
  // lugar que precisa garantir que dois elementos da mesma página não dividam um nome, que é
  // a chave do `layers` na API de render (layerNames.ts).
  dedupeLayerNames(doc);
  past.push(baseline);
  if (past.length > 80) past.shift();
  baseline = snap();
  future = [];
  persist();
  syncHistory();
  dirtyThumb();
}
function restore(json) {
  const previousPageId = page().id;
  const o = JSON.parse(json);
  doc = o.d; sel = o.s.filter((id) => o.d.pages.some((p) => p.els.some((e) => e.id === id)));
  editingId = null;
  $("docname").value = doc.name;
  renderAll();
  if (page().id !== previousPageId) { scrollToPage(doc.active); applyWorld(); }
  refreshPagesUI();
}
function undo() {
  if (!past.length) return;
  future.push(baseline);
  baseline = past.pop();
  restore(baseline);
  persist(); syncHistory();
}
function redo() {
  if (!future.length) return;
  past.push(baseline);
  baseline = future.pop();
  restore(baseline);
  persist(); syncHistory();
}
function syncHistory() {
  $("undoBtn").disabled = !past.length;
  $("redoBtn").disabled = !future.length;
}

const LS = "blank-editor-doc-v1";
let persistTimer = null;
let persistSeq = 0;
/**
 * O design aberto foi excluido no servidor. Uma aba aberta sobrevive a exclusao feita na
 * lista (ou noutra aba), e sem isto ela seguia gravando contra um id morto: cada tecla no
 * nome disparava um PUT que voltava 404 e a barra dizia "Erro ao salvar" para sempre.
 * Some da lista de abas e para de tentar; abrir outro design limpa a marca.
 */
let designGone = false;
function forgetDeletedDesign(id: string | undefined) {
  designGone = true;
  if (id) forgetRecentDesign(id);
}
const SAVE_ICON = (paths: string, cls = "") => `<svg class="${cls}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SAVE_STATES = {
  saved: { label: "Todas as alterações foram salvas", icon: SAVE_ICON(`<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/><path d="m9 14 2 2 4-4"/>`), text: "" },
  saving: { label: "Salvando…", icon: SAVE_ICON(`<path d="M21 12a9 9 0 1 1-6.2-8.6"/>`, "spin"), text: "Salvando…" },
  error: { label: "Erro ao salvar", icon: SAVE_ICON(`<path d="m2 2 20 20"/><path d="M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2"/><path d="M21.5 15.5A4.5 4.5 0 0 0 17.5 10h-1.8A7 7 0 0 0 10 5.1"/>`), text: "Erro ao salvar" },
  gone: { label: "Design excluído", icon: SAVE_ICON(`<path d="m2 2 20 20"/><path d="M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2"/><path d="M21.5 15.5A4.5 4.5 0 0 0 17.5 10h-1.8A7 7 0 0 0 10 5.1"/>`), text: "Design excluído" },
} as const;
/** Nuvem como no Canva: só ícone quando salvo; texto aparece apenas enquanto salva ou se falhar. */
function setSaveStatus(st: HTMLElement, state: keyof typeof SAVE_STATES) {
  const d = SAVE_STATES[state];
  st.innerHTML = d.icon + (d.text ? `<span>${d.text}</span>` : "");
  st.title = d.label; st.setAttribute("aria-label", d.label);
  st.dataset.state = state === "gone" ? "error" : state;
}
{ const st = document.getElementById("saveStatus"); if (st) setSaveStatus(st, "saved"); }
function persist() {
  clearTimeout(persistTimer);
  const seq = ++persistSeq;
  const st = document.getElementById("saveStatus");
  if (st) setSaveStatus(st, "saving");
  persistTimer = setTimeout(async () => {
    try { localStorage.setItem(LS, JSON.stringify(doc)); } catch (e) { /* quota or blocked */ }
    saveTemplateLocally(doc);
    const result = designGone ? "gone" : await syncTemplateToServer(doc);
    if (result === "saved" && looksGenerated(doc.seedId)) void refreshGenerationReview();
    if (result === "gone") forgetDeletedDesign(doc.seedId);
    if (seq !== persistSeq) return;
    if (st) setSaveStatus(st, result === "saved" ? "saved" : result === "gone" ? "gone" : "error");
  }, 400);
}
function loadPersisted() {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o || !Array.isArray(o.pages) || !o.pages.length) return false;
    // A saved copy of an OLDER seed would hide the current design forever.
    if (SEED.seedId && o.seedId !== SEED.seedId) { localStorage.removeItem(LS); return false; }
    doc = normalizeDoc(o); doc.active = clamp(doc.active | 0, 0, doc.pages.length - 1);
    return true;
  } catch (e) { return false; }
}


/* ============================ element factory ============================ */
function makeEl(type: string, over: Partial<El> = {}): El {
  const p = page();
  const base = {
    // O nome é a chave que `layers` usa na API de render: dois "Texto" na mesma página fariam
    // um override escrever nos dois (ver layerNames.ts).
    id: uid(), type, name: uniqueLayerName(TYPE_PT[type] || type, p.els.map((e) => e.name || "")),
    x: 0, y: 0, w: 200, h: 200, rot: 0, opacity: 1, locked: false, hidden: false,
    fill: "#8296A1", stroke: "", strokeWidth: 0, radius: 0,
  };
  const spec = {
    rect: { w: 320, h: 220, radius: 8 },
    ellipse: { w: 260, h: 260 },
    triangle: { w: 280, h: 240 },
    star: { w: 260, h: 260 },
    line: { w: 320, h: 6, fill: "#FFFFFF" },
    text: {
      w: 520, h: 90, fill: "#FFFFFF", text: "Your text here", font: "Inter",
      size: 64, weight: 700, italic: false, underline: false, align: "left",
      lh: 1.2, ls: 0,
    },
    image: { w: 420, h: 300, radius: 0 },
    icon: { w: 24, h: 24, fill: "#FFFFFF", viewBox: "0 0 24 24", path: "" },
    draw: { fill: "none", stroke: "#FFFFFF", strokeWidth: 6, pts: [] },
  }[type] || {};
  const el = { ...base, ...spec, ...over } as unknown as El;
  if (over.x === undefined) el.x = Math.round((p.w - el.w) / 2);
  if (over.y === undefined) el.y = Math.round((p.h - el.h) / 2);
  return el;
}
function addEl(type: string, over?: Partial<El>) {
  const el = makeEl(type, over);
  page().els.push(el);
  sel = [el.id];
  commit(); renderAll();
  return el;
}



/* ============================ geometry ============================ */
const rad = (d) => (d * Math.PI) / 180;
function rot(dx: number, dy: number, deg: number): { x: number; y: number } {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}
function bbox(els: El[]) {
  if (!els.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
    x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** World coordinates, in canvas pixels — the frame every page is stacked into. */
function toWorld(ev: { clientX: number; clientY: number }) {
  const r = $("world").getBoundingClientRect();
  return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom };
}



/* ============================ render: canvas ============================ */
function starPoly(n = 5) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? 0.5 : 1;
    const a = (Math.PI / n) * i - Math.PI / 2;
    pts.push(`${50 + Math.cos(a) * 50 * r}% ${50 + Math.sin(a) * 50 * r}%`);
  }
  return `polygon(${pts.join(",")})`;
}
const STAR = starPoly(5);

function elStyle(e: any) {
  const s = [
    `left:${e.x}px`, `top:${e.y}px`, `width:${e.w}px`, `height:${e.h}px`,
    `transform:rotate(${e.rot}deg)`, `opacity:${e.opacity}`,
  ];
  if (e.clip) {
    const t = Math.max(0, e.clip.y - e.y), l = Math.max(0, e.clip.x - e.x);
    const r = Math.max(0, (e.x + e.w) - (e.clip.x + e.clip.w));
    const bo = Math.max(0, (e.y + e.h) - (e.clip.y + e.clip.h));
    s.push(`clip-path:inset(${t}px ${r}px ${bo}px ${l}px)`);
  }
  const fx = [];
  if (e.blur) fx.push(`blur(${e.blur}px)`);
  if (e.filter) fx.push(e.filter);
  if (fx.length) s.push(`filter:${fx.join(" ")}`);
  if (e.hidden) s.push("display:none");
  return s.join(";");
}
/** Conteúdo de dentro do `.txt` — plano (só o texto escapado) ou rico (um `<span>` por run,
 *  cada um só declarando o que DIVERGE do estilo base do elemento). Extraída pra ser reusada
 *  fora do render normal também: depois de aplicar cor a um trecho selecionado (item "seleção de
 *  trecho de texto"), só esse `.txt` precisa ser reconstruído, não a página inteira. */
function elInner(e: any) {
  const bd = e.stroke && e.strokeWidth ? `border:${e.strokeWidth}px ${e.strokeDash || "solid"} ${e.stroke};` : "";
  const sh = e.shadow ? `box-shadow:${e.shadow.x}px ${e.shadow.y}px ${e.shadow.blur}px ${e.shadow.spread || 0}px ${e.shadow.color};` : "";
  switch (e.type) {
    case "rect":
      if (e.ring) {
        // standard CSS gradient-border trick: paint the box, mask out the middle
        return `<div style="width:100%;height:100%;background:${e.fill};border-radius:${e.radius}px;` +
          `padding:${e.ring}px;box-sizing:border-box;` +
          `-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);` +
          `-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);` +
          `mask-composite:exclude;${sh}"></div>`;
      }
      return `<div style="width:100%;height:100%;background:${e.fill};border-radius:${e.radius}px;${bd}${sh}"></div>`;
    case "ellipse":
      return `<div style="width:100%;height:100%;background:${e.fill};border-radius:50%;${bd}${sh}"></div>`;
    case "triangle":
      return `<div style="width:100%;height:100%;background:${e.fill};clip-path:polygon(50% 0,0 100%,100% 100%)"></div>`;
    case "star":
      return `<div style="width:100%;height:100%;background:${e.fill};clip-path:${STAR}"></div>`;
    case "line":
      if (e.arrowStart || e.arrowEnd) return lineSvg(e);
      return `<div style="width:100%;height:100%;background:${e.fill};border-radius:${e.h / 2}px"></div>`;
    case "image": {
      const src = srcOf(e);
      if (!src) return `<div style="width:100%;height:100%;background:var(--surface-2)"></div>`;
      if (e.imgW == null || e.imgH == null) {
        return `<img src="${src}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;border-radius:${e.radius}px;${bd}${sh}">`;
      }
      const { sizePct, positionPct } = cropToBackgroundStyle(e);
      return `<div style="width:100%;height:100%;border-radius:${e.radius}px;${bd}${sh}` +
        `background-image:url('${src}');background-repeat:no-repeat;` +
        `background-size:${sizePct[0]}% ${sizePct[1]}%;background-position:${positionPct[0]}% ${positionPct[1]}%"></div>`;
    }
    case "icon":
      return `<svg viewBox="${e.viewBox || "0 0 24 24"}" style="width:100%;height:100%;display:block"><path d="${e.path || ""}" fill="${e.fill}"/></svg>`;
    case "draw": {
      const paths = [];
      // `fillPath` is normalised 0..1 like `pts` — `transform="scale(w,h)"` blows it up to the
      // element's current pixel size without touching a single coordinate in the string, so
      // resizing the element never needs to rewrite `d`.
      // `non-scaling-stroke` mantém a largura do contorno em px do elemento, não esticada pelo
      // scale(w,h) — igual ao traço de um PDF importado.
      if (e.fillPath && e.grad) {
        // Gradiente dentro de um formato qualquer: um retângulo com o gradiente, recortado
        // pelo path. O gradiente fica em px do elemento (não distorce com scale(w,h)).
        const gid = `g${String(e.id).replace(/[^\w-]/g, "")}`;
        paths.push(`<defs>${svgGradient(gid, e)}<clipPath id="c${gid}"><path d="${e.fillPath}"${e.fillRule ? ` clip-rule="${e.fillRule}"` : ""} transform="scale(${e.w},${e.h})"/></clipPath></defs>` +
          `<rect width="${e.w}" height="${e.h}" fill="url(#${gid})" clip-path="url(#c${gid})"/>`);
        if (e.stroke && e.strokeWidth) paths.push(`<path d="${e.fillPath}" fill="none" stroke="${e.stroke}" stroke-width="${e.strokeWidth}" vector-effect="non-scaling-stroke"${dashAttr(e)} transform="scale(${e.w},${e.h})"/>`);
      } else if (e.fillPath) paths.push(`<path d="${e.fillPath}" fill="${e.fill || "none"}"${e.fillRule ? ` fill-rule="${e.fillRule}"` : ""}` +
        (e.stroke && e.strokeWidth ? ` stroke="${e.stroke}" stroke-width="${e.strokeWidth}" vector-effect="non-scaling-stroke"${dashAttr(e)}` : "") +
        ` transform="scale(${e.w},${e.h})"/>`);
      if (e.pts && e.pts.length) {
        const d = e.pts.map((p, i) => `${i ? "L" : "M"}${p[0] * e.w},${p[1] * e.h}`).join(" ");
        paths.push(`<path d="${d}" fill="none" stroke="${e.stroke}" stroke-width="${e.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
      return `<svg viewBox="0 0 ${e.w} ${e.h}" style="width:100%;height:100%;overflow:visible">${paths.join("")}</svg>`;
    }
    case "text": {
      // A base é o estilo do elemento — cada run só declara o que DIVERGE dela, então um run
      // sem `weight`/`fill`/etc. herda naturalmente por estar dentro do mesmo <div>.
      return editorTextHtml(e);
    }
  }
  return "";
}

function pageHeaderHtml(i: number, p: Page): string {
  return `<div class="pagehead" data-pageidx="${i}">
    <span class="plabel2">Página ${i + 1}<small>${p.hidden ? " · oculta" : ` · ${p.w} × ${p.h}`}</small></span>
    <div class="pageminis">
      ${pageMini("moveuppage", PAGE_MINI.up, i, "Mover página para cima", i === 0)}
      ${pageMini("movedownpage", PAGE_MINI.down, i, "Mover página para baixo", i === doc.pages.length - 1)}
      ${pageMini("duppage", PAGE_MINI.dup, i, "Duplicar página")}
      ${pageMini("pagemore", PAGE_MINI.more, i, "Mais opções da página")}
    </div>
  </div>`;
}

function renderCanvas() {
  const stack = $("pagestack");
  const stackW = stackWidth();
  stack.style.width = stackW + "px";
  stack.style.height = stackHeight() + "px";
  stack.innerHTML = doc.pages.map((p, i) => `
    <div class="pagewrap" style="top:${pageTop(i)}px; left:${(stackW - p.w) / 2}px; width:${p.w}px; height:${p.h}px;">
      ${pageHeaderHtml(i, p)}
      <div class="pagebox" data-pageidx="${i}" style="width:${p.w}px; height:${p.h}px; background:${pageBgCss(p)}; opacity:${p.hidden ? .45 : 1}">${p.els
        .map((e) => `<div class="el${e.locked ? " locked" : ""}" data-id="${e.id}" style="${elStyle(e)}">${elInner(e)}</div>`)
        .join("")}${commentsData.filter((c) => c.pageIndex === i && !c.resolved)
        .map((c) => `<div class="commentPin" data-comment-id="${c.id}" style="left:${c.x * 100}%;top:${c.y * 100}%" title="${esc(c.body)}"></div>`)
        .join("")}</div>
    </div>`).join("") +
    `<button class="addpagebtn" id="addPageCanvas" style="top:${stackHeight() + 20 / zoom}px; width:${stackW}px;">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6M12 12v6"/></svg>
      Adicionar página
    </button>`;
  fitTextElements(stack);
  // text auto-height, across every page
  for (const p of doc.pages) {
    for (const e of p.els) {
      if (e.type !== "text" || e.autoFit) continue;
      const node = stack.querySelector(`[data-txt="${e.id}"]`);
      if (node) {
        const h = Math.max(20, Math.ceil(node.scrollHeight));
        if (!Number.isFinite(e.h) || Math.abs(h - e.h) > 1) { e.h = h; (node.parentElement as HTMLElement).style.height = h + "px"; }
      }
    }
  }
  clampView(); applyWorld();
  renderOverlay();
}

/** The page nearest the viewport centre becomes "active" as you scroll, Canva-style — it's
 * what the Tela tab edits and what the bottom-bar page counter shows. */
function updateActivePageFromScroll() {
  const s = $("stage").getBoundingClientRect();
  const centerWorldY = (s.height / 2 - panY) / zoom;
  const idx = clamp(pageIndexAtWorldY(centerWorldY), 0, doc.pages.length - 1);
  if (idx !== doc.active) {
    doc.active = idx;
    $("pagecount").textContent = `${doc.active + 1} / ${doc.pages.length}`;
    if (activeTab === "page") renderPanel();
    refreshPagesUI();
  }
}

function applyWorld() {
  const stack = $("pagestack");
  stack.style.height = stackHeight() + "px";
  stack.querySelectorAll(".pagewrap").forEach((wrap, i) => {
    wrap.style.top = pageTop(i) + "px";
    wrap.querySelector(".pagehead")?.classList.toggle("compact", doc.pages[i].w * zoom < 360);
  });
  const add = $("addPageCanvas");
  if (add) add.style.top = (stackHeight() + 20 / zoom) + "px";
  $("world").style.setProperty("--page-unscale", String(1 / zoom));
  $("world").style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  $("ovl").style.setProperty("--inv", 1 / zoom);
  $("zoomval").textContent = Math.round(zoom * 100) + "%";
  $("zoomSlider").value = Math.round(zoom * 100);
  $("pagecount").textContent = `${doc.active + 1} / ${doc.pages.length}`;
  const o = $("ovl");
  o.style.width = stackWidth() + "px";
  o.style.height = stackHeight() + "px";
  const bounds = verticalBounds(stackHeight() * zoom, $("stage").clientHeight, VIEW_MARGIN);
  const scroll = $("documentScroll");
  scroll.hidden = bounds.min === bounds.max;
  $("documentScrollSize").style.height = ($("stage").clientHeight + bounds.max - bounds.min) + "px";
  const nextScroll = bounds.max - panY;
  if (Math.abs(scroll.scrollTop - nextScroll) > 1) scroll.scrollTop = nextScroll;
  positionFloatingUI();
}

$("documentScroll").addEventListener("scroll", () => {
  const bounds = verticalBounds(stackHeight() * zoom, $("stage").clientHeight, VIEW_MARGIN);
  const nextPan = bounds.max - $("documentScroll").scrollTop;
  if (Math.abs(nextPan - panY) <= 1) return;
  panY = nextPan;
  clampView(); applyWorld(); updateActivePageFromScroll();
});

const HANDLES: Array<[string, number, number]> = [["nw", 0, 0], ["n", .5, 0], ["ne", 1, 0], ["e", 1, .5], ["se", 1, 1], ["s", .5, 1], ["sw", 0, 1], ["w", 0, .5]];
const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

/** Selected elements with .y translated into world space (i.e. + their own page's stack
 * offset) — every overlay/toolbar position is computed in this frame since #ovl spans the
 * whole page stack, not a single page. */
function worldSelEls() {
  return selEls().filter((e) => !e.hidden).map((e) => ({ ...e, y: pageTop(pageIdxOf(e.id)) + e.y }));
}

function renderOverlay() {
  const o = $("ovl");
  const els = worldSelEls();
  if (!els.length || editingId) { o.innerHTML = ""; positionFloatingUI(); return; }
  let html = "";
  if (els.length === 1) {
    const e = els[0];
    const isText = e.type === "text";
    const hs = e.locked ? [] : (isText ? HANDLES.filter((h) => ["e", "w", "nw", "ne", "se", "sw"].includes(h[0])) : HANDLES);
    html += `<div class="box" style="left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;transform:rotate(${e.rot}deg)">
      <div class="tag num" style="left:0;top:0">${Math.round(e.w)} × ${Math.round(e.h)}${e.rot ? " · " + Math.round(e.rot) + "°" : ""}</div>
      ${hs.map(([k, fx, fy]) => `<div class="hdl" data-h="${k}" title="Redimensionar" style="left:${fx * 100}%;top:${fy * 100}%;cursor:${CURSORS[k]};pointer-events:auto"></div>`).join("")}
      ${e.locked ? "" : `<div class="hdl rot" data-h="rot" title="Girar" style="left:50%;top:0;margin-top:-26px;cursor:grab;pointer-events:auto"></div>`}
    </div>`;
  } else {
    const b = bbox(els);
    html += `<div class="box multi" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px">
      <div class="tag num" style="left:0;top:0">${els.length} selecionados</div>
      ${["nw", "ne", "se", "sw"].map((k) => {
        const [, fx, fy] = HANDLES.find((h) => h[0] === k);
        return `<div class="hdl" data-h="${k}" data-multi="1" title="Redimensionar" style="left:${fx * 100}%;top:${fy * 100}%;cursor:${CURSORS[k]};pointer-events:auto"></div>`;
      }).join("")}
    </div>`;
  }
  o.innerHTML = html;
  positionFloatingUI();
}

/* Anchors the slim floating toolbar (and, if open, the "more options" popover)
 * to the current selection's bounding box, in screen space — outside .world,
 * so it doesn't scale with zoom the way the on-canvas handles do. */
function positionFloatingUI() {
  const bar = $("seltoolbar"), pop = $("proppop");
  const els = worldSelEls();
  const stage = $("stage");
  bar.hidden = !els.length || !!editingId;
  const b = els.length === 1 ? els[0] : bbox(els);
  if (!bar.hidden && b) {
    const top = panY + b.y * zoom;
    const bottom = top + b.h * zoom;
    bar.hidden = bottom < 0 || top > stage.clientHeight;
    const left = panX + (b.x + b.w / 2) * zoom - bar.offsetWidth / 2;
    bar.style.left = clamp(left, 8, Math.max(8, stage.clientWidth - bar.offsetWidth - 20)) + "px";
    bar.style.top = clamp(top - bar.offsetHeight - 34, 8, Math.max(8, stage.clientHeight - bar.offsetHeight - 8)) + "px";
  }
  if (propPopOpen) {
    pop.hidden = false;
    pop.style.left = Math.max(12, stage.clientWidth - pop.offsetWidth - 20) + "px";
    pop.style.top = "12px";
  } else {
    pop.hidden = true;
  }
}

const EYEDROP_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>`;
const PAINT_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.622 17.897-10.68-2.913"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"/><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"/></svg>`;
const QALIGN_ICON = {
  left: `<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/>`,
  center: `<path d="M4 6h16"/><path d="M7 12h10"/><path d="M5.5 18h13"/>`,
  right: `<path d="M4 6h16"/><path d="M10 12h10"/><path d="M7 18h13"/>`,
  justify: `<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>`,
};
const REPLACE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 14l3-3 2.5 2.5L17 10l2 2"/><circle cx="8" cy="9" r="1.3"/></svg>`;
const LOCK_ICON = (locked: boolean) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${locked ? `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>` : `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>`}</svg>`;
const DUP_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const DEL_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const MORE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`;
const icon24 = (body: string) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const RADIUS_ICON = icon24(`<path d="M3 21V10a7 7 0 0 1 7-7h11"/>`);
const SPACING_ICON = icon24(`<path d="M21 5H11"/><path d="M21 12H11"/><path d="M21 19H11"/><path d="m3 8 3-3 3 3"/><path d="m3 16 3 3 3-3"/><path d="M6 5v14"/>`);
const OPACITY_ICON = icon24(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h6v6H3z M9 3h6v6H9z M15 9h6v6h-6z M9 15h6v6H9z" fill="currentColor" stroke="none" opacity=".35"/>`);
const BORDER_ICON = icon24(`<path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1"/>`);
const MINUS_ICON = icon24(`<path d="M5 12h14"/>`);
const PLUS_ICON = icon24(`<path d="M5 12h14"/><path d="M12 5v14"/>`);
const BOLD_ICON = icon24(`<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>`);
const ITALIC_ICON = icon24(`<path d="M19 4h-9"/><path d="M14 20H5"/><path d="M15 4 9 20"/>`);
const UNDERLINE_ICON = icon24(`<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 20h16"/>`);
const STRIKE_ICON = icon24(`<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>`);
const CASE_UPPER_ICON = icon24(`<path d="m3 15 4-8 4 8"/><path d="M4 13h6"/><path d="M15 11h4.5a2 2 0 0 1 0 4H15V7h4a2 2 0 0 1 0 4"/>`);
const LIST_ICON = icon24(`<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>`);
const SPARKLES_ICON = icon24(`<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>`);
const FLIP2_ICON = icon24(`<path d="m3 7 5 5-5 5V7"/><path d="m21 7-5 5 5 5V7"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/>`);
const FLIP2V_ICON = icon24(`<path d="m17 3-5 5-5-5h10"/><path d="m17 21-5-5-5 5h10"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/>`);
const TEXT_MORE_ICON = icon24(`<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`);
const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 120, 144];
const COLOR_PRESETS = ["#000000", "#545454", "#737373", "#a6a6a6", "#d9d9d9", "#ffffff", "#ff3131", "#ff5757", "#ff66c4", "#cb6ce6", "#8c52ff", "#5e17eb", "#0097b2", "#0cc0df", "#5ce1e6", "#38b6ff", "#5170ff", "#004aad", "#00bf63", "#7ed957", "#c1ff72", "#ffde59", "#ffbd59", "#ff914d"];
const hex6 = (c: string | undefined, fb: string) => /^#[0-9a-f]{6}$/i.test(c || "") ? c! : fb;
/** Botão de cor da barra: "A" sublinhado (texto), quadrado cheio (preenchimento), anel (borda) ou degradê. */
function colorBtn(kind: "text" | "fill" | "stroke" | "grad", popKind: TbPopKind, label: string, css: string, id: string): string {
  const open = tbPopKind === popKind;
  const inner = kind === "text"
    ? `<span class="qswatch-text">${icon24(`<path d="M4 20h16"/><path d="m6 16 6-12 6 12"/><path d="M8 12h8"/>`)}<i style="background:${css}"></i></span>`
    : `<span class="qswatch qswatch-${kind}" style="${kind === "stroke" ? `border-color:${css}` : `background:${css}`}"></span>`;
  return `<button class="qbtn qcolorbtn" id="${id}" data-tbpop="${popKind}" aria-haspopup="dialog" aria-expanded="${open}" aria-pressed="${open}" title="${label}" aria-label="${label}">${inner}</button>`;
}
const SWAP_ICON = icon24(`<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>`);
const LINE_ENDS: Array<[string, string]> = [["", "Nenhuma"], ["arrow", "Seta"], ["triangle", "Triângulo"], ["circle", "Círculo"], ["bar", "Barra"]];
/** Prévia da ponta de uma linha, desenhada sempre à direita (o início é espelhado). */
function lineEndIcon(kind: string | undefined, side: "start" | "end"): string {
  const k = kind || "";
  const tip = k === "arrow" ? `<path d="m15 7 5 5-5 5"/>`
    : k === "triangle" ? `<path d="M14 7l6 5-6 5z" fill="currentColor"/>`
    : k === "circle" ? `<circle cx="17" cy="12" r="3" fill="currentColor"/>`
    : k === "bar" ? `<path d="M20 6v12"/>` : "";
  const line = `<path d="M3 12h${k === "circle" ? 11 : k === "triangle" ? 11 : 17}"/>`;
  return icon24(`<g${side === "start" ? ` transform="matrix(-1 0 0 1 24 0)"` : ""}>${line}${tip}</g>`);
}


/* Fixed contextual bar (Toolbar): per-type controls for the current selection, docked
 * above the stage — never floats over the element itself. Mirrors the exact control set
 * Canva shows for text vs. photo vs. shape selections (see /Users/it4mi/Downloads/canva/*.html). */
function renderToolbar() {
  const bar = $("toolbar");
  const els = selEls().filter((e) => !e.hidden);
  // Stays in flow (never [hidden]) even with nothing selected — .toolbar's min-height
  // reserves the same space either way, so selecting/deselecting never shifts the stage.
  if (!els.length || editingId) {
    closeTbPop();
    bar.innerHTML = `<button class="qbtn" data-open-panel="page" title="Fundo e tamanho da página">Fundo da página</button>
      <div class="qsep"></div><button class="qbtn" id="tLayers">Camadas</button>
      <span class="toolbar-hint">${editingId ? "Editando texto" : "Selecione um elemento para editar"}</span>`;
    return;
  }
  const e = els[0];
  const one = els.length === 1;
  const t = e.type;
  let html = "";

  if (one && t === "text") {
    html += `<button class="qfont" id="tFont" aria-pressed="${activeTab === "fonts"}" title="Fonte — abrir a biblioteca"><span>${esc(fontLabel(e.font || "Inter"))}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button>`;
    html += `<div class="qsep"></div>`;
    html += `<button class="qbtn" id="tSizeDown" title="Diminuir tamanho da fonte" aria-label="Diminuir tamanho da fonte">${MINUS_ICON}</button><input class="qsizeval num" id="tSize" type="number" min="6" max="512" list="tSizeList" value="${Math.round(e.size)}" aria-label="Tamanho da fonte" title="Tamanho da fonte"><datalist id="tSizeList">${FONT_SIZES.map((n) => `<option value="${n}"></option>`).join("")}</datalist><button class="qbtn" id="tSizeUp" title="Aumentar tamanho da fonte" aria-label="Aumentar tamanho da fonte">${PLUS_ICON}</button>`;
    html += `<div class="qsep"></div>`;
    html += colorBtn("text", "fill", "Cor do texto", hex6(e.fill, "#000000"), "tFill");
    html += `<div class="qsep"></div>`;
    html += `<button class="qbtn" data-ttw="bold" aria-pressed="${e.weight >= 700}" title="Negrito (⌘B)" aria-label="Negrito">${BOLD_ICON}</button>`;
    html += `<button class="qbtn" data-ttw="italic" aria-pressed="${!!e.italic}" title="Itálico (⌘I)" aria-label="Itálico">${ITALIC_ICON}</button>`;
    html += `<button class="qbtn" data-ttw="underline" aria-pressed="${!!e.underline}" title="Sublinhado (⌘U)" aria-label="Sublinhado">${UNDERLINE_ICON}</button>`;
    html += `<button class="qbtn" data-ttw="bullets" aria-pressed="${String(e.text || "").startsWith("• ")}" title="Lista com marcadores" aria-label="Lista com marcadores">${LIST_ICON}</button>`;
    html += tbPopBtn("textMore", "tTextMore", "Mais formatação: tachado e letras maiúsculas", TEXT_MORE_ICON, !!e.strike || !!e.caps);
    html += `<div class="qsep"></div>`;
    html += (["left", "center", "right", "justify"] as const).map((a) => `<button class="qbtn" data-tta="${a}" aria-pressed="${e.align === a}" title="Alinhar ${PT_ALIGN[a]}" aria-label="Alinhar ${PT_ALIGN[a]}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${QALIGN_ICON[a]}</svg></button>`).join("");
    html += `<div class="qsep"></div>`;
    html += tbPopBtn("spacing", "tSpacing", "Espaçamento", SPACING_ICON);
  } else if (one && t === "image") {
    html += `<button class="qbtn" id="tReplace" title="Substituir imagem">${REPLACE_ICON}</button>`;
    html += colorBtn("stroke", "stroke", "Cor da borda", hex6(e.stroke, "#FFFFFF"), "tStroke");
    html += `${tbPopBtn("radius", "tRadius", "Arredondar cantos", RADIUS_ICON, (e.radius || 0) > 0)}`;
    html += tbPopBtn("flip", "tFlip", "Inverter", FLIP2_ICON);
  } else if (one) {
    const showFill = ["rect", "ellipse", "triangle", "star", "line", "icon"].includes(t) || (t === "draw" && !!e.fillPath && e.fill !== "none");
    const showStroke = ["rect", "ellipse", "draw"].includes(t);
    const showRadius = t === "rect";
    const hex = (c: string, fb: string) => /^#[0-9a-f]{6}$/i.test(c) ? c : fb;
    if (e.grad?.stops?.length >= 2) {
      // Gradiente (ex.: vindo de PDF): edita a cor de início e de fim; o ângulo e as paradas
      // do meio continuam como vieram.
      const st = e.grad.stops;
      html += colorBtn("grad", "grad", "Cores do degradê", `linear-gradient(135deg, ${hex(st[0][0], "#000000")}, ${hex(st[st.length - 1][0], "#ffffff")})`, "tGrad");
    } else if (showFill) html += colorBtn("fill", "fill", t === "line" ? "Cor da linha" : "Cor de preenchimento", hex(e.fill, "#000000"), "tFill");
    if (showStroke) {
      html += tbPopBtn("border", "tBorder", "Estilo da borda", BORDER_ICON, (e.strokeWidth || 0) > 0);
    }
    if (t === "line") {
      html += tbPopBtn("arrowStart", "tArrowStart", "Início da linha", lineEndIcon(e.arrowStart, "start"));
      html += `<button class="qbtn" id="tArrowSwap" title="Trocar pontas" aria-label="Trocar pontas">${SWAP_ICON}</button>`;
      html += tbPopBtn("arrowEnd", "tArrowEnd", "Fim da linha", lineEndIcon(e.arrowEnd, "end"));
    }
    if (showRadius) html += `${tbPopBtn("radius", "tRadius", "Arredondar cantos", RADIUS_ICON, (e.radius || 0) > 0)}`;
    html += tbPopBtn("flip", "tFlip", "Inverter", FLIP2_ICON);
  }

  if (one && "EyeDropper" in window && t !== "image") html += `<button class="qbtn" id="tEyedrop" title="Conta-gotas: pegar uma cor da tela">${EYEDROP_ICON}</button>`;
  html += `<button class="qbtn" id="tCopyStyle" aria-pressed="${!!copiedStyle}" title="Copiar estilo (⌥⌘C)" aria-label="Copiar estilo">${PAINT_ICON}</button>`;
  if (copiedStyle) html += `<span class="qchip" role="status">Clique no destino · Esc cancela</span>`;
  html += `<div class="qsep"></div>`;
  html += tbPopBtn("opacity", "tOpacity", "Transparência", OPACITY_ICON, (e.opacity ?? 1) < 1);
  html += `<div class="qgroup-text">`;
  if (one && t === "text") {
    const fxOn = !!(e.shadow || e.curve || e.textFx);
    html += `<button class="qbtn qtext" id="tFx" aria-pressed="${propPopOpen && panelTab === "effects"}" title="Efeitos: sombra, contorno, fundo, degradê, curvar">${SPARKLES_ICON}<span>Efeitos</span>${fxOn ? `<i class="qdot" aria-label="Efeito ativo"></i>` : ""}</button>`;
  }
  html += `<button class="qbtn qtext" id="tPosition" aria-pressed="${propPopOpen && (panelTab === "organize" || panelTab === "layers")}" title="Posição: organizar e camadas">Posição</button></div>`;

  bar.innerHTML = html;
  placeTbPop();
  updateToolbarFade();
}
/** Marca as bordas da barra que têm conteúdo escondido (fade via mask em chrome.css). */
function updateToolbarFade() {
  const bar = $("toolbar");
  const max = bar.scrollWidth - bar.clientWidth;
  bar.classList.toggle("is-scroll-l", max > 1 && bar.scrollLeft > 1);
  bar.classList.toggle("is-scroll-r", max > 1 && bar.scrollLeft < max - 1);
}
$("toolbar").addEventListener("scroll", () => { updateToolbarFade(); placeTbPop(); }, { passive: true });
window.addEventListener("resize", updateToolbarFade);
/** Mudar o corpo da caixa inteira mantém a proporção dos trechos com corpo próprio (um título
 *  com uma palavra maior continua com ela maior), como no Canva. */
function sizePatch(e: any, size: number) {
  if (!e?.runs?.some((r: any) => r.size)) return { size };
  const k = size / (e.size || size);
  return { size, runs: e.runs.map((r: any) => (r.size ? { ...r, size: Math.round(r.size * k * 100) / 100 } : r)) };
}
$("toolbar").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-open-panel]")) { setPanel("page"); return; }
  if (t.closest("#tLayers")) { panelTab = "layers"; propPopOpen = true; renderProps(); positionFloatingUI(); return; }
  const tw = t.closest<HTMLElement>("[data-ttw]");
  if (tw) {
    const k = tw.dataset.ttw, e = selEls()[0];
    if (k === "bold") patch({ weight: e.weight >= 700 ? 400 : 700 }, true);
    if (k === "italic") patch({ italic: !e.italic }, true);
    if (k === "underline") patch({ underline: !e.underline }, true);
    if (k === "bullets") { const r = toggleBullets(e.text, e.runs); patch({ text: r.text, ...(r.runs ? { runs: r.runs } : {}) }, true); }
    renderToolbar(); return;
  }
  const ta = t.closest<HTMLElement>("[data-tta]");
  if (ta) { patch({ align: ta.dataset.tta }, true); renderToolbar(); return; }
  const tf = t.closest<HTMLElement>("[data-tflip]");
  if (tf) { flip(tf.dataset.tflip); return; }
  if (t.closest("#tSizeUp")) { const e = selEls()[0]; patch(sizePatch(e, (e.size || 16) + 2), true); renderToolbar(); return; }
  if (t.closest("#tSizeDown")) { const e = selEls()[0]; patch(sizePatch(e, Math.max(6, (e.size || 16) - 2)), true); renderToolbar(); return; }
  const pb = t.closest<HTMLElement>("[data-tbpop]");
  if (pb) { toggleTbPop(pb.dataset.tbpop as TbPopKind); return; }
  if (t.closest("#tReplace")) { $("fileImgReplace").click(); return; }
  if (t.closest("#tCopyStyle")) { armCopyStyle(); return; }
  if (t.closest("#tArrowSwap")) { const e = selEls()[0]; patch({ arrowStart: e.arrowEnd, arrowEnd: e.arrowStart }, true); renderToolbar(); return; }
  if (t.closest("#tEyedrop")) { void eyedrop(); return; }
  if (t.closest("#tFont")) { setPanel(activeTab === "fonts" ? null : "fonts"); return; }
  if (t.closest("#tFx")) { propPopOpen = true; panelTab = "effects"; renderProps(); positionFloatingUI(); return; }
  if (t.closest("#tPosition")) { propPopOpen = true; panelTab = "organize"; renderProps(); positionFloatingUI(); return; }
});
$("toolbar").addEventListener("input", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === "tSize" && Number(t.value) >= 6) patch(sizePatch(selEls()[0], clamp(Number(t.value), 6, 512)));
});
/** Cores escolhidas no popover de cor (#tbPop): texto/preenchimento, borda e as pontas do degradê. */
function applyColor(target: string, value: string) {
  const e = selEls()[0]; if (!e) return;
  if (target === "fill") patch({ fill: value });
  else if (target === "stroke") patch({ stroke: value, ...(e.strokeWidth ? {} : { strokeWidth: 2 }) });
  else if ((target === "grad0" || target === "grad1") && e.grad?.stops?.length) {
    const last = e.grad.stops.length - 1;
    const stops = e.grad.stops.map((st: [string, number], i: number) =>
      (target === "grad0" && i === 0) || (target === "grad1" && i === last) ? [value, st[1]] as [string, number] : st);
    const grad = { ...e.grad, stops };
    patch({ grad, fill: gradToCss(grad) });
  }
}
$("toolbar").addEventListener("change", (ev) => {
  const id = (ev.target as HTMLElement).id;
  if (id === "tSize") {
    const input = ev.target as HTMLInputElement;
    const size = Number(input.value);
    if (!Number.isFinite(size) || size < 6) { input.value = String(selEls()[0]?.size ?? 16); return; }
    input.value = String(clamp(size, 6, 512));
  }
  if (id === "tSize") commit();
});
$("toolbar").addEventListener("keydown", (ev) => {
  if (ev.target.id === "tSize" && ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
});
$("toolbar").addEventListener("focusout", (ev) => {
  if (ev.target.id !== "tSize") return;
  ev.target.value = String(selEls()[0]?.size ?? 16);
  if (snap() !== baseline) commit();
});

function useImageAsBg() {
  const e = selEls()[0];
  if (!e || e.type !== "image") return;
  const pg = doc.pages[pageIdxOf(e.id)];
  pg.bgImage = e.src; pg.els = pg.els.filter((x) => x.id !== e.id); sel = [];
  commit(); renderAll(); toast("Imagem virou o fundo da página");
}

/* The slim always-visible bar above the selection — Canva's own "floating toolbar" only ever
 * carries universal actions (never per-type controls, those live in the fixed Toolbar above). */
function renderSelToolbar() {
  const bar = $("seltoolbar");
  const els = selEls().filter((e) => !e.hidden);
  if (!els.length || editingId) { bar.innerHTML = ""; return; }
  const locked = els.every((e) => e.locked);
  let html = "";
  html += `<button class="qbtn" id="qLock" aria-pressed="${locked}" title="${locked ? "Desbloquear" : "Bloquear"}">${LOCK_ICON(locked)}</button>`;
  html += `<button class="qbtn" id="qDup" title="Duplicar (⌘D)">${DUP_ICON}</button>`;
  html += `<button class="qbtn" id="qDel" title="Excluir (Delete)" aria-label="Excluir" style="color:var(--danger)">${DEL_ICON}</button>`;
  html += `<button class="qbtn" id="qMore" aria-pressed="${ctxMenuOpen}" title="Mais opções" aria-label="Mais opções">${MORE_ICON}</button>`;
  bar.innerHTML = html;
}
$("seltoolbar").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#qLock")) { const locked = selEls().every((e) => e.locked); for (const e of selEls()) e.locked = !locked; commit(); renderAll(); return; }
  if (t.closest("#qDup")) { duplicateSel(); return; }
  if (t.closest("#qDel")) { deleteSel(); return; }
  const more = t.closest<HTMLElement>("#qMore");
  if (more) { const r = more.getBoundingClientRect(); openContextMenu(r.left, r.bottom + 6); return; }
});
/* Popovers do Toolbar (arredondar cantos, espaçamento, transparência, borda, pontas da linha):
 * um botão com ícone abre um painel pequeno com controles rotulados, como no Canva. Fica fora
 * do #toolbar para sobreviver aos re-renders da barra durante o arraste de um slider. */
type TbPopKind = "radius" | "spacing" | "opacity" | "border" | "arrowStart" | "arrowEnd" | "textMore" | "flip" | "fill" | "stroke" | "grad";
let tbPopKind: TbPopKind | null = null;
const tbPopEl = document.createElement("div");
tbPopEl.className = "tbpop"; tbPopEl.id = "tbPop"; tbPopEl.hidden = true;
tbPopEl.setAttribute("role", "dialog");
(document.getElementById("view-editor") || document.body).appendChild(tbPopEl);
function tbPopBtn(kind: TbPopKind, id: string, label: string, iconHtml: string, active = false): string {
  const open = tbPopKind === kind;
  return `<button class="qbtn${active ? " is-set" : ""}" id="${id}" data-tbpop="${kind}" aria-haspopup="dialog" aria-expanded="${open}" aria-pressed="${open}" title="${label}" aria-label="${label}">${iconHtml}</button>`;
}
function closeTbPop() {
  if (!tbPopKind) return;
  tbPopKind = null; tbPopEl.hidden = true;
  $("toolbar").querySelectorAll("[data-tbpop]").forEach((b) => { b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-pressed", "false"); });
}
function toggleTbPop(kind: TbPopKind) {
  if (tbPopKind === kind) { closeTbPop(); return; }
  tbPopKind = kind; renderTbPop(); renderToolbar();
}
const sliderRow = (id: string, label: string, min: number, max: number, step: number, val: number, suffix = "") =>
  `<div class="tbpop-row"><label for="${id}">${label}</label>
    <div class="tbpop-ctl"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">
    <span class="tbpop-num"><input type="number" id="${id}N" data-twin="${id}" min="${min}" max="${max}" step="${step}" value="${val}" aria-label="${label}">${suffix}</span></div></div>`;
function renderTbPop() {
  const e = selEls()[0];
  if (!tbPopKind || !e) { closeTbPop(); return; }
  const k = tbPopKind;
  let html = "";
  if (k === "radius") {
    const max = Math.max(1, Math.floor(Math.min(e.w, e.h) / 2));
    html = `<h5>Arredondar cantos</h5>` + sliderRow("tpRadius", "Arredondamento de cantos", 0, max, 1, Math.min(max, Math.round(e.radius || 0)));
  } else if (k === "spacing") {
    html = `<h5>Espaçamento</h5>` + sliderRow("tLs", "Espaçamento entre letras", -200, 800, 1, Math.round(e.ls || 0))
      + sliderRow("tLh", "Espaçamento entre linhas", 0.5, 2.5, 0.05, Math.round((e.lh || 1.2) * 100) / 100);
  } else if (k === "opacity") {
    html = `<h5>Transparência</h5>` + sliderRow("tOp", "Opacidade", 0, 100, 1, Math.round((e.opacity ?? 1) * 100), "%");
  } else if (k === "border") {
    const w = e.strokeWidth || 0, cur = w <= 0 ? "none" : (e.strokeDash || "solid");
    const styles: Array<[string, string, string]> = [
      ["none", "Sem borda", `<circle cx="12" cy="12" r="8"/><path d="m6.5 17.5 11-11"/>`],
      ["solid", "Sólida", `<path d="M3 12h18"/>`],
      ["dashed", "Tracejada", `<path d="M3 12h4M10 12h4M17 12h4"/>`],
      ["dotted", "Pontilhada", `<path d="M4 12h.01M9 12h.01M14 12h.01M19 12h.01" stroke-width="3"/>`]];
    html = `<h5>Estilo da borda</h5><div class="tbpop-grid" role="group" aria-label="Estilo da borda">${styles.map(([v, l, ic]) =>
      `<button class="qbtn" data-dash="${v}" aria-pressed="${cur === v}" title="${l}" aria-label="${l}">${icon24(ic)}</button>`).join("")}</div>`
      + sliderRow("tStrokeW", "Espessura da borda", 0, 50, 1, Math.round(w))
      + `<div class="tbpop-row tbpop-inline"><label for="tStroke">Cor da borda</label><input type="color" id="tStroke" class="qcolor" value="${/^#[0-9a-f]{6}$/i.test(e.stroke) ? e.stroke : "#000000"}"></div>`;
  } else if (k === "textMore") {
    html = `<h5>Mais formatação</h5><div class="tbpop-list">
      <button class="qbtn tbpop-item" data-ttw="strike" aria-pressed="${!!e.strike}">${STRIKE_ICON}<span>Tachado</span></button>
      <button class="qbtn tbpop-item" data-ttw="caps" aria-pressed="${!!e.caps}" aria-label="Letras maiúsculas">${CASE_UPPER_ICON}<span>Letras maiúsculas</span></button></div>`;
  } else if (k === "flip") {
    html = `<h5>Inverter</h5><div class="tbpop-list">
      <button class="qbtn tbpop-item" data-tflip="h">${FLIP2_ICON}<span>Inverter na horizontal</span></button>
      <button class="qbtn tbpop-item" data-tflip="v">${FLIP2V_ICON}<span>Inverter na vertical</span></button></div>`;
  } else if (k === "fill" || k === "stroke" || k === "grad") {
    const rows: Array<[string, string, string]> = k === "grad"
      ? [["grad0", "Cor inicial", hex6(e.grad?.stops?.[0]?.[0], "#000000")], ["grad1", "Cor final", hex6(e.grad?.stops?.[(e.grad?.stops?.length || 1) - 1]?.[0], "#ffffff")]]
      : [[k, k === "stroke" ? "Cor da borda" : e.type === "text" ? "Cor do texto" : e.type === "line" ? "Cor da linha" : "Cor de preenchimento", hex6(k === "stroke" ? e.stroke : e.fill, k === "stroke" ? "#ffffff" : "#000000")]];
    const docColors = [...new Set(doc.pages.flatMap((pg) => pg.els.flatMap((x) => [x.fill, x.stroke])).filter((c): c is string => /^#[0-9a-f]{6}$/i.test(c || "")).map((c) => c.toLowerCase()))].slice(0, 12);
    const sw = (target: string, c: string) => `<button class="tbpop-sw" data-color="${c}" data-target="${target}" style="background:${c}" title="${c.toUpperCase()}" aria-label="Cor ${c.toUpperCase()}"></button>`;
    html = `<h5>${k === "grad" ? "Cores do degradê" : rows[0][1]}</h5>` + rows.map(([target, label, v]) =>
      `<div class="tbpop-row tbpop-inline"><label for="tpColor-${target}">${k === "grad" ? label : "Cor personalizada"}</label><input type="color" id="tpColor-${target}" data-target="${target}" class="qcolor" value="${v}"></div>`
      + (k === "grad" ? "" : (docColors.length ? `<div class="tbpop-row"><label>Cores do documento</label><div class="tbpop-swatches">${docColors.map((c) => sw(target, c)).join("")}</div></div>` : "")
        + `<div class="tbpop-row"><label>Cores padrão</label><div class="tbpop-swatches">${COLOR_PRESETS.map((c) => sw(target, c)).join("")}</div></div>`)).join("");
  } else {
    const side = k === "arrowStart" ? "start" : "end";
    const cur = (side === "start" ? e.arrowStart : e.arrowEnd) || "";
    html = `<h5>${side === "start" ? "Início da linha" : "Fim da linha"}</h5><div class="tbpop-grid" role="group">${LINE_ENDS.map(([v, l]) =>
      `<button class="qbtn" data-end="${v}" aria-pressed="${cur === v}" title="${l}" aria-label="${l}">${lineEndIcon(v, side)}</button>`).join("")}</div>`;
  }
  tbPopEl.innerHTML = html;
  tbPopEl.setAttribute("aria-label", tbPopEl.querySelector("h5")?.textContent || "");
  tbPopEl.hidden = false;
  placeTbPop();
}
function placeTbPop() {
  if (!tbPopKind) return;
  const b = $("toolbar").querySelector(`[data-tbpop="${tbPopKind}"]`) as HTMLElement | null;
  if (!b) { closeTbPop(); return; }
  const r = b.getBoundingClientRect();
  const w = tbPopEl.offsetWidth || 260;
  tbPopEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  tbPopEl.style.top = r.bottom + 8 + "px";
}
function applyTbPopInput(id: string, v: number) {
  const e = selEls()[0]; if (!e || !Number.isFinite(v)) return;
  if (id === "tpRadius") patch({ radius: clamp(v, 0, Math.min(e.w, e.h) / 2) });
  if (id === "tLs") patch({ ls: clamp(v, -200, 800) });
  if (id === "tLh" && v > 0) patch({ lh: clamp(v, 0.5, 2.5) });
  if (id === "tOp") patch({ opacity: clamp(v / 100, 0, 1) });
  if (id === "tStrokeW") patch({ strokeWidth: clamp(v, 0, 200), ...(v > 0 && !e.stroke ? { stroke: "#000000" } : {}) });
}
tbPopEl.addEventListener("input", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === "tStroke") { patch({ stroke: t.value, ...(selEls()[0]?.strokeWidth ? {} : { strokeWidth: 2 }) }); return; }
  if (t.id.startsWith("tpColor-")) { applyColor(t.dataset.target || "", t.value); renderToolbar(); return; }
  const base = t.dataset.twin || t.id;
  const twin = tbPopEl.querySelector<HTMLInputElement>(t.dataset.twin ? `#${base}` : `#${base}N`);
  if (twin) twin.value = t.value;
  applyTbPopInput(base, parseFloat(t.value));
});
tbPopEl.addEventListener("change", () => { if (snap() !== baseline) commit(); renderToolbar(); });
tbPopEl.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const d = t.closest<HTMLElement>("[data-dash]");
  if (d) {
    const v = d.dataset.dash, e = selEls()[0];
    if (v === "none") patch({ strokeWidth: 0, strokeDash: undefined }, true);
    else patch({ strokeDash: (v === "solid" ? undefined : v) as any, ...(e?.strokeWidth ? {} : { strokeWidth: 2, stroke: e?.stroke || "#000000" }) }, true);
    renderTbPop(); renderToolbar(); return;
  }
  const swc = t.closest<HTMLElement>("[data-color]");
  if (swc) { applyColor(swc.dataset.target || "", swc.dataset.color || ""); commit(); renderTbPop(); renderToolbar(); return; }
  const tw = t.closest<HTMLElement>("[data-ttw]");
  if (tw) {
    const e = selEls()[0]; if (!e) return;
    if (tw.dataset.ttw === "strike") patch({ strike: !e.strike }, true);
    if (tw.dataset.ttw === "caps") patch({ caps: !e.caps }, true);
    renderTbPop(); renderToolbar(); return;
  }
  const tf = t.closest<HTMLElement>("[data-tflip]");
  if (tf) { flip(tf.dataset.tflip); closeTbPop(); return; }
  const en = t.closest<HTMLElement>("[data-end]");
  if (en) {
    const v = (en.dataset.end || undefined) as any;
    patch(tbPopKind === "arrowStart" ? { arrowStart: v } : { arrowEnd: v }, true);
    renderTbPop(); renderToolbar(); return;
  }
});
window.addEventListener("pointerdown", (ev) => {
  const t = ev.target as HTMLElement | null;
  if (tbPopKind && t && !t.closest("#tbPop, [data-tbpop]")) closeTbPop();
}, true);
window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && tbPopKind) { closeTbPop(); ev.stopPropagation(); } }, true);
window.addEventListener("resize", placeTbPop);

/* Tooltip próprio nas barras (Toolbar, barra flutuante, barra de trecho, popovers): aparece
 * depois de 400 ms, sem o atraso longo e o visual do title nativo. O title vira data-tip. */
const tipEl = document.createElement("div");
tipEl.className = "tip"; tipEl.setAttribute("role", "tooltip"); tipEl.hidden = true;
document.body.appendChild(tipEl);
let tipTimer = 0, tipFor: HTMLElement | null = null;
function hideTip() { clearTimeout(tipTimer); tipFor = null; tipEl.hidden = true; }
document.addEventListener("pointerover", (ev) => {
  const host = (ev.target as HTMLElement).closest?.<HTMLElement>("#toolbar [title], #toolbar [data-tip], #seltoolbar [title], #seltoolbar [data-tip], #textSelToolbar [title], #textSelToolbar [data-tip], #tbPop [title], #tbPop [data-tip]");
  if (!host || host === tipFor) return;
  if (host.title) { host.dataset.tip = host.title; if (!host.getAttribute("aria-label")) host.setAttribute("aria-label", host.title); host.removeAttribute("title"); }
  hideTip(); tipFor = host;
  tipTimer = window.setTimeout(() => {
    if (tipFor !== host || !host.isConnected) return;
    tipEl.textContent = host.dataset.tip || ""; tipEl.hidden = false;
    const r = host.getBoundingClientRect(), w = tipEl.offsetWidth;
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    const below = r.bottom + 8 + tipEl.offsetHeight < window.innerHeight;
    tipEl.style.top = (below ? r.bottom + 8 : r.top - 8 - tipEl.offsetHeight) + "px";
  }, 400);
});
document.addEventListener("pointerout", (ev) => { if (tipFor && !tipFor.contains(ev.relatedTarget as Node)) hideTip(); });
document.addEventListener("pointerdown", hideTip, true);

$("fileImgReplace").addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  const e = selEls()[0];
  if (!f || !e || e.type !== "image") return;
  const src = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(f); });
  const img = await loadImg(src).catch(() => null);
  if (!img) { toast(`Não foi possível ler ${f.name}.`); return; }
  patch({ src }, true);
});

/* ============================ context menu ============================ */
function openContextMenu(clientX: number, clientY: number) {
  ctxMenuOpen = true;
  renderContextMenu();
  const el = $("ctxmenu");
  el.hidden = false;
  el.style.left = clientX + "px";
  el.style.top = clientY + "px";
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) el.style.left = Math.max(8, clientX - r.width) + "px";
    if (r.bottom > window.innerHeight - 8) el.style.top = Math.max(8, clientY - r.height) + "px";
  });
  renderSelToolbar();
}
function closeContextMenu() {
  if (!ctxMenuOpen) return;
  ctxMenuOpen = false;
  $("ctxmenu").hidden = true;
  renderSelToolbar();
}
const ci = (p: string) => `<svg class="ctxicon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const CI = {
  copy: ci(`<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`),
  style: ci(`<rect x="2" y="2" width="16" height="6" rx="2"/><path d="M10 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="8" y="16" width="4" height="6" rx="1"/>`),
  paste: ci(`<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>`),
  dup: ci(`<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16V4a2 2 0 0 1 2-2h12"/><path d="M15 12v6M12 15h6"/>`),
  del: ci(`<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>`),
  group: ci(`<path d="M3 7V5c0-1.1.9-2 2-2h2M17 3h2c1.1 0 2 .9 2 2v2M21 17v2c0 1.1-.9 2-2 2h-2M7 21H5c-1.1 0-2-.9-2-2v-2"/><rect x="7" y="7" width="7" height="5" rx="1"/><rect x="10" y="12" width="7" height="5" rx="1"/>`),
  ungroup: ci(`<rect x="5" y="4" width="8" height="6" rx="1"/><rect x="11" y="14" width="8" height="6" rx="1"/>`),
  layers: ci(`<path d="m12.8 2.2 8.6 3.9a1 1 0 0 1 0 1.8l-8.6 3.9a2 2 0 0 1-1.6 0L2.6 7.9a1 1 0 0 1 0-1.8l8.6-3.9a2 2 0 0 1 1.6 0z"/><path d="m22 12-9.2 4.2a2 2 0 0 1-1.6 0L2 12"/><path d="m22 17-9.2 4.2a2 2 0 0 1-1.6 0L2 17"/>`),
  align: ci(`<path d="M12 2v20"/><rect x="5" y="5" width="14" height="5" rx="1"/><rect x="8" y="14" width="8" height="5" rx="1"/>`),
  image: ci(`<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>`),
  lock: ci(`<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`),
  unlock: ci(`<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>`),
};
const CTX_ORDER = [["front", "Trazer para a frente"], ["up", "Avançar"], ["down", "Recuar"], ["back", "Enviar para trás"]] as const;
const CTX_ALIGN = [["left", "Esquerda"], ["cx", "Centro"], ["right", "Direita"], ["top", "Cima"], ["cy", "Meio"], ["bottom", "Baixo"]] as const;
function renderContextMenu() {
  const els = selEls();
  const hasSel = els.length > 0;
  const locked = hasSel && els.every((e) => e.locked);
  const canGroup = canGroupElements(page().els, sel);
  const canUngroup = canUngroupElements(page().els, sel);
  const dis = (ok: boolean) => (ok ? "" : "disabled");
  $("ctxmenu").innerHTML = `
    <button class="ctxitem" data-ctx="copy" ${dis(hasSel)}>${CI.copy}Copiar<span class="ctxkey">⌘C</span></button>
    ${copiedStyle || hasSel ? `<button class="ctxitem" data-ctx="copystyle" ${dis(hasSel)}>${CI.style}Copiar estilo<span class="ctxkey">⌥⌘C</span></button>` : ""}
    <button class="ctxitem" data-ctx="paste" ${dis(!!clipboard?.length)}>${CI.paste}Colar<span class="ctxkey">⌘V</span></button>
    <button class="ctxitem" data-ctx="duplicate" ${dis(hasSel)}>${CI.dup}Duplicar<span class="ctxkey">⌘D</span></button>
    <div class="ctxsep"></div>
    <button class="ctxitem" data-ctx="group" ${dis(canGroup)}>${CI.group}Agrupar<span class="ctxkey">⌘G</span></button>
    <button class="ctxitem" data-ctx="ungroup" ${dis(canUngroup)}>${CI.ungroup}Desagrupar<span class="ctxkey">⇧⌘G</span></button>
    <div class="ctxsep"></div>
    <div class="ctxitem has-sub">${CI.layers}Camada<span class="ctxarrow">›</span>
      <div class="ctxsub">
        ${CTX_ORDER.map(([k, label]) => `<button class="ctxitem" data-ctxorder="${k}" ${dis(hasSel)}>${label}</button>`).join("")}
      </div>
    </div>
    <div class="ctxitem has-sub">${CI.align}Alinhar à página<span class="ctxarrow">›</span>
      <div class="ctxsub ctxalign">
        ${CTX_ALIGN.map(([k, label]) => `<button class="ctxitem" data-ctxalign="${k}" ${dis(hasSel)}>${label}</button>`).join("")}
      </div>
    </div>
    ${els.length === 1 && els[0].type === "image" ? `<div class="ctxsep"></div><button class="ctxitem" data-ctx="asbg">${CI.image}Usar como fundo</button>` : ""}
    <div class="ctxsep"></div>
    <button class="ctxitem" data-ctx="lock" ${dis(hasSel)}>${locked ? CI.unlock : CI.lock}${locked ? "Desbloquear" : "Bloquear"}</button>
    <button class="ctxitem" data-ctx="code" ${dis(hasSel)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>Ver código (JSON)</button>
    <div class="ctxsep"></div>
    <button class="ctxitem danger" data-ctx="delete" ${dis(hasSel)}>${CI.del}Excluir<span class="ctxkey">Delete</span></button>
  `;
}
$("ctxmenu").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  if (b.dataset.ctx === "copy") copySel();
  else if (b.dataset.ctx === "paste") paste();
  else if (b.dataset.ctx === "copystyle") { if (!copiedStyle) armCopyStyle(); }
  else if (b.dataset.ctx === "asbg") useImageAsBg();
  else if (b.dataset.ctx === "duplicate") duplicateSel();
  else if (b.dataset.ctx === "delete") deleteSel();
  else if (b.dataset.ctx === "code") { panelTab = "code"; propPopOpen = true; renderProps(); positionFloatingUI(); }
  else if (b.dataset.ctx === "group") groupSel();
  else if (b.dataset.ctx === "ungroup") ungroupSel();
  else if (b.dataset.ctx === "pghide") togglePageHidden(+b.dataset.page!);
  else if (b.dataset.ctx === "pgadd") insertBlankPageAfter(+b.dataset.page!);
  else if (b.dataset.ctx === "pgdel") deletePage(+b.dataset.page!);
  else if (b.dataset.ctx === "lock") { const locked = selEls().every((e) => e.locked); for (const e of selEls()) e.locked = !locked; commit(); renderAll(); }
  else if (b.dataset.ctxorder) order(b.dataset.ctxorder);
  else if (b.dataset.ctxalign) align(b.dataset.ctxalign);
  else return;
  closeContextMenu();
});
window.addEventListener("pointerdown", (ev) => {
  const t = ev.target as HTMLElement | null;
  // The inspector stays open while selecting artwork or using undo/redo.
  // Its close button and Escape dismiss it; only context menus close outside.
  if (ctxMenuOpen && t && !t.closest("#ctxmenu")) closeContextMenu();
}, true);



/* ============================ pointer interaction ============================ */
let drag = null;
let spaceDown = false;

// Right-click pans the canvas (see the pointerdown handler below) instead of opening the
// browser's native menu, matching Canva.
$("stage").addEventListener("contextmenu", (ev) => ev.preventDefault());

$("stage").addEventListener("pointerdown", (ev) => {
  // Comentários (item 4.3): enquanto armado, o clique NÃO deve virar seleção/marquee — é
  // tratado aqui, antes de qualquer outra checagem, e sempre desarma depois de um clique
  // (dentro ou fora de uma página).
  if (placingComment) {
    const pageBox = (ev.target as HTMLElement).closest<HTMLElement>(".pagebox");
    if (pageBox) {
      const r = pageBox.getBoundingClientRect();
      const pageIdx = +pageBox.dataset.pageidx;
      const x = clamp((ev.clientX - r.left) / r.width, 0, 1);
      const y = clamp((ev.clientY - r.top) / r.height, 0, 1);
      openCommentCompose(pageIdx, x, y);
    } else {
      toast("Clique dentro de uma página pra fixar o comentário.");
    }
    placingComment = false;
    $("stage").style.cursor = tool === "hand" ? "grab" : tool === "draw" ? "crosshair" : "default";
    return;
  }
  // A comment pin is a click target on its own (opens the comments panel), never the start of
  // a marquee/select drag.
  const pin = (ev.target as HTMLElement).closest(".commentPin");
  if (pin) { openComments(); return; }
  // The floating selection toolbar, its "more options" popover, the tool belt, the bottom
  // bar, the thumbnail strip, and each page's own floating header/add-page button are UI
  // chrome living inside .stage — not canvas content, so a click there must never fall
  // through to marquee-select.
  if ((ev.target as HTMLElement).closest("#seltoolbar, #proppop, #tbPop, #documentScroll, #ctxmenu, .pagehead, #addPageCanvas, #textSelToolbar, #fontMissing")) return;
  // Right-click only pans when it actually drags — a plain right-click (no movement) opens
  // the Context Menu instead, matching how canvas tools commonly split the two.
  if (ev.button === 2) { startRightClickPanOrMenu(ev); return; }
  // Middle-click, Space+drag, or the hand tool all pan — matching Canva's own set of ways
  // to pan the canvas.
  if (ev.button === 1 || spaceDown || tool === "hand") { startPan(ev); return; }
  const hdl = ev.target.closest(".hdl");
  if (hdl) { startTransform(ev, hdl); return; }
  const node = ev.target.closest(".el");

  if (tool === "draw") { startDraw(ev); return; }

  if (!node) {
    const pageBox = (ev.target as HTMLElement).closest<HTMLElement>(".pagebox");
    if (pageBox) doc.active = +pageBox.dataset.pageidx;
    if (editingId) stopEditing();
    startMarquee(ev);
    return;
  }
  const id = node.dataset.id;
  const el = byId(id);
  if (!el || el.hidden) return;
  doc.active = pageIdxOf(id);
  if (editingId && editingId !== id) stopEditing();
  // Pincel de estilo armado: o clique aplica o estilo copiado neste elemento, sem selecionar.
  if (copiedStyle && !sel.includes(id)) {
    if (pasteStyle(el, copiedStyle)) { commit(); toast("Estilo aplicado"); }
    else toast(copiedStyle.kind === "text" ? "Esse estilo é de texto — clique numa caixa de texto." : "Esse estilo é de forma — clique numa forma ou imagem.");
    copiedStyle = null; document.body.classList.remove("painting");
    renderAll(); renderToolbar(); ev.preventDefault(); return;
  }

  // Selecting an element re-renders the canvas (see capture()'s unconditional
  // renderAll() on pointerup), which swaps in a fresh .el DOM node before a real
  // second click can land — so the browser's own "dblclick" event never fires
  // here. Detect the double-click ourselves instead, by id and timing.
  const now = Date.now();
  const isDoubleClick = lastClickId === id && now - lastClickTime < 400;
  lastClickId = isDoubleClick ? null : id;
  lastClickTime = isDoubleClick ? 0 : now;
  if (isDoubleClick && el.type === "text" && editingId !== id) {
    sel = [id];
    startEditingText(id);
    return;
  }

  if (el.locked) { sel = [id]; renderAll(); return; }

  if (ev.shiftKey) sel = sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id];
  else if (!sel.includes(id)) {
    const ownerPage = doc.pages[pageIdxOf(id)];
    sel = el.group && ownerPage ? ownerPage.els.filter((x) => x.group === el.group).map((x) => x.id) : [id];
  }
  renderOverlay(); renderLayers(); renderProps();
  if (editingId === id) return;
  startMove(ev);
});

/* Right-click: a plain click (no movement) opens the Context Menu at the cursor — if it
 * landed on an element, that element is selected first. Dragging still pans, exactly like
 * middle-click/Space, so the existing "right-click pans" habit keeps working. */
function startRightClickPanOrMenu(ev) {
  ev.preventDefault();
  const sx = ev.clientX, sy = ev.clientY, px = panX, py = panY;
  let moved = false;
  drag = {
    move: (e) => {
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 4) moved = true;
      if (moved) { panX = px + (e.clientX - sx); panY = py + (e.clientY - sy); clampView(); applyWorld(); updateActivePageFromScroll(); }
    },
    up: (e) => {
      if (moved) return;
      const node = (e.target as HTMLElement).closest<HTMLElement>(".el");
      if (node) {
        const id = node.dataset.id;
        const el = byId(id);
        if (el && !el.hidden && !sel.includes(id)) sel = [id];
      }
      openContextMenu(e.clientX, e.clientY);
    },
  };
  capture(ev);
}

function startPan(ev) {
  ev.preventDefault();
  const sx = ev.clientX, sy = ev.clientY, px = panX, py = panY;
  drag = {
    move: (e) => {
      panX = px + (e.clientX - sx); panY = py + (e.clientY - sy);
      clampView(); applyWorld(); updateActivePageFromScroll();
    },
    up: () => {},
  };
  capture(ev);
}

/* Dragging can carry an element from one page into another (Canva-style). While the drag is
 * live, moved elements are shown via unclipped "ghost" copies in #ovl (world space, so they
 * can visually cross a page's own overflow:hidden boundary); the real data — and which
 * page's `els` array actually owns each element — only updates on drop. */
function startMove(ev) {
  const start = toWorld(ev);
  const els = selEls().filter((e) => !e.locked);
  if (!els.length) return;
  const orig = els.map((e) => ({ e, pageIdx: pageIdxOf(e.id), x: e.x, y: e.y }));
  let moved = false;
  const ghosts = orig.map((o) => {
    const g = document.createElement("div");
    g.className = "el dragghost";
    g.style.cssText = elStyle(o.e);
    g.innerHTML = elInner(o.e);
    $("ovl").appendChild(g);
    // O fantasma e HTML recem-montado, com o corpo original em `data-auto-fit`. So o
    // renderCanvas roda o ajuste, e ele nao alcanca o `#ovl` — sem isto uma manchete
    // importada era arrastada no corpo cheio, transbordando a pagina, enquanto o elemento
    // ajustado seguia parado no lugar de origem: dois textos na tela, um "fixo" e um "real".
    // Depois do appendChild porque o ajuste mede o layout.
    fitTextElements(g);
    return g;
  });
  const place = (dx: number, dy: number) => {
    orig.forEach((o, i) => {
      ghosts[i].style.left = (o.x + dx) + "px";
      ghosts[i].style.top = (pageTop(o.pageIdx) + o.y + dy) + "px";
    });
  };
  place(0, 0);
  drag = {
    move: (e) => {
      const p = toWorld(e);
      let dx = p.x - start.x, dy = p.y - start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5) moved = true;
      const g = snapMove(orig, dx, dy, e.altKey);
      dx += g.dx; dy += g.dy;
      place(dx, dy);
      drawGuides(g.guides, orig[0].pageIdx);
      moved && renderProps();
    },
    up: (e) => {
      ghosts.forEach((g) => g.remove());
      clearGuides();
      if (!moved) return;
      const p = toWorld(e);
      let dx = p.x - start.x, dy = p.y - start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const g = snapMove(orig, dx, dy, e.altKey);
      dx += g.dx; dy += g.dy;
      for (const o of orig) {
        const worldY = pageTop(o.pageIdx) + o.y + dy;
        const targetPageIdx = pageIndexAtWorldY(worldY + o.e.h / 2);
        if (targetPageIdx !== o.pageIdx) {
          const arr = doc.pages[o.pageIdx].els;
          const at = arr.indexOf(o.e);
          if (at >= 0) arr.splice(at, 1);
          doc.pages[targetPageIdx].els.push(o.e);
        }
        o.e.x = Math.round(o.x + dx);
        o.e.y = Math.round(worldY - pageTop(targetPageIdx));
      }
      commit();
    },
  };
  capture(ev);
}

/** Snaps against the OTHER elements on the drag's starting page only — once the selection has
 * moved into a different page's territory, snapping simply stops rather than re-targeting. */
function snapMove(orig, dx: number, dy: number, off: boolean) {
  if (off) return { dx: 0, dy: 0, guides: [] };
  const pageIdx = orig[0].pageIdx;
  const p = doc.pages[pageIdx];
  const movingIds = new Set(orig.map((o) => o.e.id));
  const others = p.els.filter((e) => !movingIds.has(e.id) && !e.hidden);
  const xs = orig.map((o) => o.x + dx), ys = orig.map((o) => o.y + dy);
  const b = {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...orig.map((o) => o.x + dx + o.e.w)) - Math.min(...xs),
    h: Math.max(...orig.map((o) => o.y + dy + o.e.h)) - Math.min(...ys),
  };
  const T = 6 / zoom, guides = [];
  const xt = [p.w / 2, 0, p.w], yt = [p.h / 2, 0, p.h];
  for (const o of others) { xt.push(o.x, o.x + o.w / 2, o.x + o.w); yt.push(o.y, o.y + o.h / 2, o.y + o.h); }
  let sdx = 0, sdy = 0, bx = T, by = T, gx = null, gy = null;
  for (const t of xt) for (const v of [b.x, b.x + b.w / 2, b.x + b.w]) {
    const d = t - v; if (Math.abs(d) < bx) { bx = Math.abs(d); sdx = d; gx = t; }
  }
  for (const t of yt) for (const v of [b.y, b.y + b.h / 2, b.y + b.h]) {
    const d = t - v; if (Math.abs(d) < by) { by = Math.abs(d); sdy = d; gy = t; }
  }
  if (gx !== null) guides.push({ v: 1, at: gx });
  if (gy !== null) guides.push({ v: 0, at: gy });
  return { dx: Math.round(sdx), dy: Math.round(sdy), guides };
}
function drawGuides(gs, pageIdx: number) {
  clearGuides();
  const o = $("ovl");
  const top = pageTop(pageIdx), p = doc.pages[pageIdx];
  for (const g of gs) {
    const d = document.createElement("div");
    d.className = "guide";
    if (g.v) { d.style.cssText = `left:${g.at}px;top:${top}px;width:1px;height:${p.h}px`; }
    else { d.style.cssText = `top:${top + g.at}px;left:0;height:1px;width:${p.w}px`; }
    d.dataset.guide = "1";
    o.appendChild(d);
  }
}
const clearGuides = () => $("ovl").querySelectorAll("[data-guide]").forEach((n) => n.remove());

function startTransform(ev, hdl) {
  ev.stopPropagation();
  const kind = hdl.dataset.h;
  const multi = hdl.dataset.multi === "1";
  const els = selEls().filter((e) => !e.locked);
  if (!els.length) return;
  const start = toWorld(ev);

  if (kind === "rot") {
    const e = els[0];
    const top = pageTop(pageIdxOf(e.id));
    const cx = e.x + e.w / 2, cy = top + e.y + e.h / 2;
    const a0 = Math.atan2(start.y - cy, start.x - cx) * 180 / Math.PI;
    const r0 = e.rot;
    drag = {
      move: (m) => {
        const p = toWorld(m);
        let a = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI - a0 + r0;
        if (m.shiftKey) a = Math.round(a / 15) * 15;
        e.rot = Math.round(((a % 360) + 360) % 360);
        renderCanvas(); renderProps();
      },
      up: () => commit(),
    };
    capture(ev); return;
  }

  if (multi) {
    const b = bbox(els);
    const orig = els.map((e) => ({ e, x: e.x, y: e.y, w: e.w, h: e.h, size: e.size }));
    drag = {
      move: (m) => {
        const p = toWorld(m);
        let sx = 1, sy = 1;
        if (kind.includes("e")) sx = (p.x - b.x) / b.w;
        if (kind.includes("w")) sx = (b.x + b.w - p.x) / b.w;
        if (kind.includes("s")) sy = (p.y - b.y) / b.h;
        if (kind.includes("n")) sy = (b.y + b.h - p.y) / b.h;
        const s = Math.max(.05, m.shiftKey ? Math.max(sx, sy) : Math.min(sx, sy));
        const ax = kind.includes("w") ? b.x + b.w : b.x;
        const ay = kind.includes("n") ? b.y + b.h : b.y;
        for (const o of orig) {
          o.e.w = Math.max(4, Math.round(o.w * s));
          o.e.h = Math.max(4, Math.round(o.h * s));
          o.e.x = Math.round(ax + (o.x - ax) * s);
          o.e.y = Math.round(ay + (o.y - ay) * s);
          if (o.size) o.e.size = Math.max(6, Math.round(o.size * s));
        }
        renderCanvas();
      },
      up: () => commit(),
    };
    capture(ev); return;
  }

  const e = els[0];
  const o = { x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rot, size: e.size };
  const cx0 = o.x + o.w / 2, cy0 = o.y + o.h / 2;
  const isText = e.type === "text";
  const corner = kind.length === 2;
  drag = {
    move: (m) => {
      const p = toWorld(m);
      const d = rot(p.x - start.x, p.y - start.y, -o.rot);
      let nw = o.w, nh = o.h, ox = 0, oy = 0;
      if (kind.includes("e")) nw = o.w + d.x;
      if (kind.includes("w")) { nw = o.w - d.x; ox = d.x; }
      if (kind.includes("s")) nh = o.h + d.y;
      if (kind.includes("n")) { nh = o.h - d.y; oy = d.y; }
      nw = Math.max(8, nw); nh = Math.max(8, nh);
      if (corner && (m.shiftKey || isText || e.type === "image")) {
        const r = o.w / o.h, byW = Math.abs(nw / o.w - 1) > Math.abs(nh / o.h - 1);
        if (byW) nh = nw / r; else nw = nh * r;
        if (kind.includes("w")) ox = o.w - nw;
        if (kind.includes("n")) oy = o.h - nh;
      }
      if (isText && corner && o.size) e.size = Math.max(6, Math.round(o.size * (nw / o.w)));
      if (isText && !corner) nh = o.h;
      const lc = { x: ox + nw / 2 - o.w / 2, y: oy + nh / 2 - o.h / 2 };
      const wc = rot(lc.x, lc.y, o.rot);
      e.w = Math.round(nw); e.h = Math.round(nh);
      e.x = Math.round(cx0 + wc.x - nw / 2);
      e.y = Math.round(cy0 + wc.y - nh / 2);
      renderCanvas(); renderProps();
    },
    up: () => commit(),
  };
  capture(ev);
}

function startMarquee(ev) {
  const start = toWorld(ev);
  const box = document.createElement("div");
  box.className = "marquee";
  $("ovl").appendChild(box);
  if (!ev.shiftKey) { sel = []; renderOverlay(); renderLayers(); renderProps(); }
  const base = [...sel];
  drag = {
    move: (m) => {
      const p = toWorld(m);
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
      const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
      box.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      const hit: string[] = [];
      doc.pages.forEach((pg, pi) => {
        const top = pageTop(pi);
        for (const e of pg.els) {
          if (e.hidden) continue;
          const ey = top + e.y;
          if (e.x < x + w && e.x + e.w > x && ey < y + h && ey + e.h > y) hit.push(e.id);
        }
      });
      sel = [...new Set([...base, ...hit])];
      renderLayers();
    },
    up: () => { box.remove(); renderOverlay(); renderProps(); },
  };
  capture(ev);
}

function startDraw(ev) {
  const start = toWorld(ev);
  const pts = [[start.x, start.y]];
  drag = {
    move: (m) => {
      const p = toWorld(m);
      pts.push([p.x, p.y]);
      const b = ptsBox(pts);
      const prev = $("ovl").querySelector("[data-ink]");
      if (prev) prev.remove();
      const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      s.dataset.ink = "1";
      s.setAttribute("style", `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;overflow:visible`);
      s.innerHTML = `<path d="${pts.map((q, i) => `${i ? "L" : "M"}${q[0] - b.x},${q[1] - b.y}`).join(" ")}" fill="none" stroke="${pen.color}" stroke-width="${pen.width}" stroke-opacity="${pen.alpha}" stroke-linecap="round" stroke-linejoin="round"/>`;
      $("ovl").appendChild(s);
    },
    up: () => {
      $("ovl").querySelectorAll("[data-ink]").forEach((n) => n.remove());
      if (pts.length < 2) return;
      const b = ptsBox(pts);
      doc.active = pageIndexAtWorldY(b.y + b.h / 2);
      addEl("draw", {
        x: Math.round(b.x), y: Math.round(b.y - pageTop(doc.active)), w: Math.round(b.w), h: Math.round(b.h),
        pts: pts.map((q) => [(q[0] - b.x) / (b.w || 1), (q[1] - b.y) / (b.h || 1)]),
        name: "Desenho", stroke: pen.color, strokeWidth: pen.width, opacity: pen.alpha,
      });
    },
  };
  capture(ev);
}
function ptsBox(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(4, Math.max(...xs) - x), h: Math.max(4, Math.max(...ys) - y) };
}

function capture(ev) {
  ev.preventDefault();
  const move = (e) => drag && drag.move(e);
  const up = (e) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (drag) { drag.up(e); drag = null; }
    renderAll();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/* text editing */
function startEditingText(id) {
  const el = byId(id);
  const node = $("pagestack").querySelector(`.el[data-id="${id}"]`);
  // Locked only guards position/size/deletion — text content stays editable, since template
  // authors lock fields specifically to keep them from being moved while still filling them in.
  if (!el || !node || el.type !== "text") return;
  editingId = el.id;
  renderOverlay();
  const t = node.querySelector(".txt");
  if (el.curve || el.textFx?.type === "hollow" || el.textFx?.type === "grad") {
    // Editar texto curvo/vazado/degradê em cima do texto "de verdade", visível e reto; o efeito
    // volta ao sair da edição (renderAll).
    t.style.color = el.fill; t.style.webkitTextFillColor = el.fill; t.style.background = "none";
    node.querySelector(".curvesvg")?.remove();
  }
  t.setAttribute("contenteditable", "true");
  t.focus();
  document.getSelection().selectAllChildren(t);
  t.addEventListener("input", refitEditingText);
  t.addEventListener("blur", onEditingBlur);
}

/** Sair da caixa encerra a edição — exceto quando o foco vai para os controles do trecho
 *  (tamanho/fonte): aí a edição continua e o foco volta para a caixa ao aplicar. */
function onEditingBlur(ev: FocusEvent) {
  const to = ev.relatedTarget as Node | null;
  if (to && $("textSelToolbar").contains(to)) return;
  (ev.target as HTMLElement).removeEventListener("blur", onEditingBlur);
  stopEditing();
}
$("textSelToolbar").addEventListener("focusout", (ev) => {
  const to = ev.relatedTarget as Node | null;
  if (!editingId || (to && $("textSelToolbar").contains(to))) return;
  const node = $("pagestack").querySelector(`[data-txt="${editingId}"]`);
  if (to && node?.contains(to)) return;
  // Foco saiu dos controles para fora da caixa: mesmo efeito de sair da caixa.
  setTimeout(() => { if (editingId && !node?.contains(document.activeElement)) { node?.removeEventListener("blur", onEditingBlur as any); stopEditing(); } }, 0);
});

/**
 * Enquanto se digita, o `.txt` e contenteditable: o texto muda sem passar por renderCanvas, e
 * nada reaplicava o ajuste de corpo. Uma manchete importada (autoFit) continuava desenhada no
 * corpo original e transbordava a caixa; o tamanho certo so voltava ao sair da edicao, quando
 * renderAll roda o fit de novo - dai parecerem dois textos, um "fixo" e outro "real". Refazer
 * o ajuste a cada tecla deixa na tela, o tempo todo, o texto que vai ser gravado.
 */
function refitEditingText() {
  if (!editingId) return;
  const el = byId(editingId);
  const t = $("pagestack").querySelector(`[data-txt="${editingId}"]`) as HTMLElement | null;
  const box = t?.parentElement as HTMLElement | undefined;
  if (!el || !t || !box) return;
  // Uma caixa com autoFit tem altura fixa e o corpo e que cede; sem autoFit e o contrario,
  // a caixa cresce - o mesmo par de regras que renderCanvas aplica depois de montar o HTML.
  if (el.autoFit) { fitTextElements(box); return; }
  const h = Math.max(20, Math.ceil(t.scrollHeight));
  if (!Number.isFinite(el.h) || Math.abs(h - el.h) > 1) { el.h = h; box.style.height = h + "px"; }
  renderOverlay();
}
function stopEditing() {
  if (!editingId) return;
  const t = $("pagestack").querySelector(`[data-txt="${editingId}"]`);
  const el = byId(editingId);
  if (t && el) {
    const v = t.innerText.replace(/ /g, " ").replace(/\n$/, "");
    t.removeEventListener("input", refitEditingText);
    t.removeEventListener("blur", onEditingBlur as any);
    t.removeAttribute("contenteditable");
    if (v !== el.text) {
      // Mantém negrito/cor/fonte de cada trecho (vindos do PDF ou aplicados à mão) em vez de
      // achatar a caixa inteira no estilo base a cada edição de texto.
      const runs = el.runs?.length ? runsFromEditable(t as HTMLElement, v, el.size) : null;
      const replacement = replaceTemplateText(el, v, doc.fonts);
      delete el.runs;
      Object.assign(el, replacement);
      if (runs && runs.some((r) => Object.keys(r).length > 1)) el.runs = runs;
      commit();
      loadDesignFonts(doc).then(() => { if (editorMounted) renderAll(); }).catch(() => toast("Não foi possível carregar as fontes do design."));
    }
  }
  editingId = null;
  hideTextSelToolbar();
  renderAll();
}

/** Runs lidos da caixa em edição: cada nó de texto com o estilo inline do `<span>` (run) em
 *  que está. `null` se o texto reconstruído não bater com `expected` (estrutura que o
 *  contenteditable criou e este leitor não entende) — aí quem chama cai no texto plano. */
function runsFromEditable(container: HTMLElement, expected: string, baseSize: number) {
  const pieces: Array<{ text: string; style: StyleOverride }> = [];
  const styleOf = (node: Node): StyleOverride => {
    const out: StyleOverride = {};
    const chain: HTMLElement[] = [];
    for (let n = node.parentElement; n && n !== container; n = n.parentElement) chain.unshift(n);
    for (const n of chain) {
      const st = n.style;
      if (st.fontWeight) out.weight = Number(st.fontWeight) || (st.fontWeight === "bold" ? 700 : 400);
      if (st.fontStyle) out.italic = st.fontStyle === "italic";
      if (st.textDecoration) out.underline = st.textDecoration.includes("underline");
      if (st.color) out.fill = st.color;
      if (st.fontFamily) out.font = st.fontFamily.split(",")[0].replace(/["']/g, "").trim();
      if (st.fontSize) out.size = st.fontSize.endsWith("em") ? Math.round(parseFloat(st.fontSize) * baseSize * 100) / 100 : parseFloat(st.fontSize);
    }
    return out;
  };
  const walk = (node: Node, first: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) { pieces.push({ text: (node.textContent || "").replace(/\u00a0/g, " "), style: styleOf(node) }); return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") { pieces.push({ text: "\n", style: styleOf(node) }); return; }
    if (!first && (node.tagName === "DIV" || node.tagName === "P")) pieces.push({ text: "\n", style: {} });
    node.childNodes.forEach((c, i) => walk(c, first && i === 0));
  };
  container.childNodes.forEach((c, i) => walk(c, i === 0));
  const runs = runsFromPieces(pieces);
  const text = runs.map((r) => r.text).join("").replace(/\n$/, "");
  if (text !== expected) return null;
  if (runs.length && runs[runs.length - 1].text.endsWith("\n")) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\n$/, "");
  return runs.filter((r) => r.text);
}

/** Deslocamento em caracteres de texto plano de um ponto de fronteira de Range, relativo ao
 *  início de `container` — funciona igual esteja o conteúdo num nó de texto só (caixa sem
 *  `runs`) ou espalhado em vários `<span>` (uma run por span): `Range.toString()` concatena o
 *  texto de todos os nós que atravessa, então basta medir um range do início até esse ponto. */
function textOffsetOf(container: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(container);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** Seleção de um TRECHO de texto (dentro de uma caixa em edição), pra aplicar cor só nele — não
 *  é a seleção de ELEMENTOS (`sel`), é a seleção de caracteres dentro de UM elemento de texto.
 *  Guardada à parte (não só lida de `document.getSelection()` na hora de aplicar) porque clicar
 *  no seletor de cor rouba a seleção nativa do navegador antes do evento `input` disparar. */
let pendingTextSelection: { start: number; end: number } | null = null;

function hideTextSelToolbar() {
  $("textSelToolbar").hidden = true;
  pendingTextSelection = null;
}

/** Reage a QUALQUER mudança de seleção na página (não só dentro da caixa de texto) — por isso a
 *  primeira coisa é sair se não houver edição de texto rolando ou se a seleção não estiver
 *  dentro da caixa sendo editada. Quando está: guarda o trecho em `pendingTextSelection` e
 *  posiciona o popover de cor logo acima da seleção, usando `getBoundingClientRect()` — em
 *  coordenadas de viewport, as mesmas que `position:fixed` (`.textSelToolbar`) espera, sem
 *  precisar repetir a conta de zoom/pan que os elementos do canvas usam. */
function updateTextSelToolbar() {
  if (!editingId) { hideTextSelToolbar(); return; }
  // Digitando o tamanho ou escolhendo a fonte do trecho: a seleção "some" da caixa, mas o
  // trecho guardado continua valendo.
  if ($("textSelToolbar").contains(document.activeElement)) return;
  const container = $("pagestack").querySelector(`[data-txt="${editingId}"]`);
  const sel = document.getSelection();
  if (!container || !sel || sel.rangeCount === 0 || sel.isCollapsed) { hideTextSelToolbar(); return; }
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) { hideTextSelToolbar(); return; }
  const a = textOffsetOf(container, range.startContainer, range.startOffset);
  const b = textOffsetOf(container, range.endContainer, range.endOffset);
  const start = Math.min(a, b), end = Math.max(a, b);
  if (start === end) { hideTextSelToolbar(); return; }
  pendingTextSelection = { start, end };
  fillTextSelControls(start);
  const rect = range.getBoundingClientRect();
  const bar = $("textSelToolbar");
  bar.style.left = (rect.left + rect.width / 2) + "px";
  bar.style.top = rect.top + "px";
  bar.hidden = false;
}
document.addEventListener("selectionchange", updateTextSelToolbar);

// Sem isto, clicar no seletor de cor rouba o foco da caixa em edição, dispara o `blur` dela
// (que já está ligado a `stopEditing`, ver `startEditingText`) e a seleção nativa do navegador
// desaparece ANTES do evento `input` do seletor disparar — `pendingTextSelection` existiria à
// toa. `preventDefault` no `mousedown` evita o input roubar o foco (testado: o `click` que abre
// o seletor nativo de cor do sistema continua disparando normalmente).
$("textSelColor").addEventListener("mousedown", (ev) => ev.preventDefault());

/** B/I/U só no trecho selecionado. Liga se alguma parte do trecho ainda não tem o estilo,
 *  desliga se o trecho inteiro já tem — mesmo comportamento de Docs/Canva. */
function toggleSelectionStyle(kind: "bold" | "italic" | "underline" | "strike") {
  if (!editingId || !pendingTextSelection) return;
  const el = byId(editingId);
  if (!el) return;
  const { start, end } = pendingTextSelection;
  const base: StyleOverride = { weight: el.weight, italic: el.italic, underline: el.underline, strike: el.strike };
  const has = kind === "bold" ? (s: StyleOverride) => (s.weight ?? 400) >= 600
    : kind === "italic" ? (s: StyleOverride) => !!s.italic
    : kind === "strike" ? (s: StyleOverride) => !!s.strike : (s: StyleOverride) => !!s.underline;
  const on = !rangeEvery(el.text, el.runs, start, end, base, has);
  const override: StyleOverride = kind === "bold" ? { weight: on ? 700 : (el.weight >= 600 ? 400 : el.weight) }
    : kind === "italic" ? { italic: on } : kind === "strike" ? { strike: on } : { underline: on };
  el.runs = applyStyleToRange(el.text, el.runs, start, end, override);
  commit();
  const node = $("pagestack").querySelector(`[data-txt="${editingId}"]`);
  if (node) {
    node.innerHTML = textRunsHtml(el);
    // Reseleciona o mesmo trecho: dá pra aplicar B e depois I em seguida, sem selecionar de novo.
    reselectTextRange(node as HTMLElement, start, end);
  }
  // Negrito/itálico novos precisam da face carregada (se a família tiver) — não bloqueia.
  loadDesignFonts(doc).catch(() => {});
}

/** Estilo efetivo no caractere `pos` (run por cima do elemento). */
function styleAt(el: any, pos: number) {
  let acc = 0;
  for (const r of el.runs ?? []) {
    acc += r.text.length;
    if (pos < acc) return { font: r.font || el.font, size: r.size || el.size };
  }
  return { font: el.font, size: el.size };
}

/** Fontes oferecidas no trecho: as do design primeiro, depois a biblioteca compartilhada. */
function textSelFontOptions(current: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  const add = (f?: string) => { if (f && !seen.has(f)) { seen.add(f); out.push(f); } };
  add(current);
  for (const p of doc.pages) for (const e of p.els) if (e.type === "text") { add(e.font); for (const r of e.runs ?? []) add(r.font); }
  for (const f of doc.fonts ?? []) add(f.family);
  for (const f of globalFonts) add(f.family);
  return out;
}

function fillTextSelControls(start: number) {
  const el = editingId ? byId(editingId) : null;
  if (!el) return;
  const st = styleAt(el, start);
  ($("textSelSize") as HTMLInputElement).value = String(Math.round(st.size));
  const sel = $("textSelFont") as HTMLSelectElement;
  sel.innerHTML = textSelFontOptions(st.font).map((f) => `<option value="${esc(f)}"${f === st.font ? " selected" : ""}>${esc(fontLabel(f))}</option>`).join("");
}

/** Aplica corpo/fonte só ao trecho, mantendo a seleção para ajustes seguidos. */
async function applyToSelection(override: StyleOverride) {
  if (!editingId || !pendingTextSelection) return;
  const el = byId(editingId);
  if (!el) return;
  const { start, end } = pendingTextSelection;
  if (override.font) {
    // Carrega as faces da família antes de pintar — sem isso o trecho pisca na fonte padrão.
    const fonts = withGlobalFontFamily(doc.fonts ?? [], globalFonts, override.font);
    try { await loadDesignFonts({ ...doc, fonts }); doc.fonts = fonts; } catch { /* segue com fallback */ }
    if (override.font === el.font) override = { ...override, font: undefined };
  }
  if (override.size !== undefined && Math.abs(override.size - el.size) < 0.01) override = { ...override, size: undefined };
  const clear = Object.fromEntries(Object.keys(override).map((k) => [k, (override as any)[k]]));
  el.runs = applyStyleToRange(el.text, el.runs, start, end, clear as StyleOverride);
  commit();
  const node = $("pagestack").querySelector(`[data-txt="${editingId}"]`) as HTMLElement | null;
  if (node) { node.innerHTML = textRunsHtml(el); node.focus(); refitEditingText(); reselectTextRange(node, start, end); }
}

function reselectTextRange(container: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0, n: Node | null, setStart = false;
  while ((n = walker.nextNode())) {
    const len = (n.textContent || "").length;
    if (!setStart && start <= pos + len) { range.setStart(n, start - pos); setStart = true; }
    if (setStart && end <= pos + len) { range.setEnd(n, end - pos); break; }
    pos += len;
  }
  const sel = document.getSelection();
  if (sel && setStart) { sel.removeAllRanges(); sel.addRange(range); }
}

$("textSelToolbar").addEventListener("mousedown", (ev) => {
  if ((ev.target as HTMLElement).closest("[data-tsel]")) ev.preventDefault();
});
$("textSelToolbar").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-tsel]");
  if (!b) return;
  const k = b.dataset.tsel!;
  if (k === "size-up" || k === "size-down") {
    const cur = Number(($("textSelSize") as HTMLInputElement).value) || 16;
    const next = clamp(k === "size-up" ? cur + 2 : cur - 2, 4, 512);
    ($("textSelSize") as HTMLInputElement).value = String(next);
    void applyToSelection({ size: next });
    return;
  }
  toggleSelectionStyle(k as "bold" | "italic" | "underline" | "strike");
});
// Campo e seletor roubam o foco da caixa em edição; guardamos o trecho e o restauramos no fim.
$("textSelSize").addEventListener("change", (ev) => {
  const n = Number((ev.target as HTMLInputElement).value);
  if (Number.isFinite(n) && n >= 4) void applyToSelection({ size: clamp(n, 4, 512) });
});
$("textSelSize").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); (ev.target as HTMLInputElement).dispatchEvent(new Event("change")); } });
$("textSelFont").addEventListener("change", (ev) => { void applyToSelection({ font: (ev.target as HTMLSelectElement).value }); });
document.addEventListener("keydown", (ev) => {
  if (!editingId || !pendingTextSelection || !(ev.metaKey || ev.ctrlKey)) return;
  const k = ev.key.toLowerCase();
  const kind = k === "b" ? "bold" : k === "i" ? "italic" : k === "u" ? "underline" : ev.shiftKey && k === "x" ? "strike" : null;
  if (!kind) return;
  ev.preventDefault();
  toggleSelectionStyle(kind);
}, true);
$("textSelColor").addEventListener("input", (ev) => {
  if (!editingId || !pendingTextSelection) return;
  const el = byId(editingId);
  if (!el) return;
  const { start, end } = pendingTextSelection;
  el.runs = applyStyleToRange(el.text, el.runs, start, end, { fill: (ev.target as HTMLInputElement).value });
  commit();
  // Só este `.txt` é reconstruído — um `renderCanvas()` inteiro derrubaria o `contenteditable`
  // que ainda está ativo nele (a pessoa pode querer colorir outro trecho em seguida).
  const node = $("pagestack").querySelector(`[data-txt="${editingId}"]`);
  if (node) node.innerHTML = textRunsHtml(el);
  hideTextSelToolbar();
});

/* scroll + zoom wheel */
$("stage").addEventListener("wheel", (ev) => {
  if ((ev.target as HTMLElement).closest("#proppop, #tbPop, #seltoolbar, #ctxmenu, #documentScroll")) return;
  ev.preventDefault();
  // Ctrl/Cmd+wheel zooms the document — and so does a trackpad pinch, which the browser
  // reports as exactly that. A bare wheel ALWAYS scrolls the document and must never touch
  // the zoom: that's the difference between a document and an infinite canvas.
  if (ev.ctrlKey || ev.metaKey) {
    zoomAt(ev.clientX, ev.clientY, zoom * (1 - ev.deltaY * 0.01));
    return;
  }
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? $("stage").clientHeight : 1;
  panX -= (ev.shiftKey ? ev.deltaY : ev.deltaX) * unit;
  panY -= ev.shiftKey ? 0 : ev.deltaY * unit;
  clampView(); applyWorld(); updateActivePageFromScroll();
}, { passive: false });

const ZOOM_MIN = 0.1, ZOOM_MAX = 3;
/** Rescales the document around the point under the cursor, so the page you're looking at
 * doesn't jump out from under you. */
function zoomAt(cx, cy, nz) {
  const r = $("stage").getBoundingClientRect();
  const sx = cx - r.left, sy = cy - r.top;
  const wx = (sx - panX) / zoom;
  const nextZoom = clamp(nz, ZOOM_MIN, ZOOM_MAX);
  panY = zoomedPanY(doc.pages, panY, sy, zoom, nextZoom);
  zoom = nextZoom;
  fitView = false;
  panX = sx - wx * zoom;
  clampView(); applyWorld(); updateActivePageFromScroll(); renderOverlay();
}
/** Scrolls the document so page `i` is what updateActivePageFromScroll() will also call
 * active: centred if it fits the viewport, aligned to its top edge if it's taller. */
function scrollToPage(i: number) {
  const s = $("stage").getBoundingClientRect();
  const p = doc.pages[i];
  panY = p.h * zoom <= s.height - 80
    ? s.height / 2 - (pageTop(i) + p.h / 2) * zoom
    : -pageTop(i) * zoom + VIEW_MARGIN;
  clampView();
}
/** "Ajustar": zooms so the whole active page fits the viewport with padding, then scrolls to it. */
function zoomFit() {
  const s = $("stage").getBoundingClientRect();
  const p = page();
  if (!s.width || !s.height) return;
  fitView = true;
  zoom = clamp(Math.min((s.width - 64) / p.w, (s.height - 112) / p.h), ZOOM_MIN, ZOOM_MAX);
  panX = (s.width - stackWidth() * zoom) / 2;
  scrollToPage(doc.active);
  applyWorld(); renderOverlay();
}



/* ============================ commands ============================ */
function deleteSel() {
  const locked = selEls().some((e) => e.locked);
  const before = selEls().filter((e) => !e.locked).length;
  for (const p of doc.pages) p.els = p.els.filter((e) => !sel.includes(e.id) || e.locked);
  if (!locked) sel = [];
  commit(); renderAll();
  if (before) toast(before > 1 ? `${before} elementos excluídos` : "Elemento excluído", { kind: "ok", action: { label: "Desfazer", fn: undo } });
}
function groupSel() {
  if (!groupElements(page().els, sel, uid())) return;
  commit(); renderAll();
}
function ungroupSel() {
  if (!ungroupElements(page().els, sel)) return;
  commit(); renderAll();
}
// Copies keep grouping *among themselves* but never rejoin the original group they came from —
// otherwise a duplicated group would silently merge back into the source group.
function remapGroupIds(copies) {
  const map = new Map();
  for (const c of copies) {
    if (!c.group) continue;
    if (!map.has(c.group)) map.set(c.group, uid());
    c.group = map.get(c.group);
  }
  return copies;
}
function duplicateSel() {
  const els = selEls();
  if (!els.length) return;
  const copies = remapGroupIds(els.map((e) => ({ ...structuredClone(e), id: uid(), x: e.x + 24, y: e.y + 24 })));
  els.forEach((e, i) => doc.pages[pageIdxOf(e.id)].els.push(copies[i]));
  sel = copies.map((c) => c.id);
  commit(); renderAll();
}
function copySel() {
  const els = selEls();
  if (els.length) { clipboard = structuredClone(els); toast(`${els.length} copiado(s)`); }
}
function paste() {
  if (!clipboard?.length) return;
  const copies = remapGroupIds(clipboard.map((e) => ({ ...structuredClone(e), id: uid(), x: e.x + 30, y: e.y + 30 })));
  page().els.push(...copies);
  sel = copies.map((c) => c.id);
  commit(); renderAll();
}
function order(dir) {
  const byPage = new Map<number, string[]>();
  for (const id of sel) {
    const idx = pageIdxOf(id);
    if (!byPage.has(idx)) byPage.set(idx, []);
    byPage.get(idx).push(id);
  }
  for (const [pIdx, ids] of byPage) {
    const p = doc.pages[pIdx];
    const idx = ids.map((id) => p.els.findIndex((e) => e.id === id)).filter((i) => i >= 0).sort((a, b) => a - b);
    if (!idx.length) continue;
    if (dir === "front") { const m = idx.map((i) => p.els[i]); for (const e of m) { p.els.splice(p.els.indexOf(e), 1); p.els.push(e); } }
    if (dir === "back") { const m = idx.map((i) => p.els[i]); for (const e of [...m].reverse()) { p.els.splice(p.els.indexOf(e), 1); p.els.unshift(e); } }
    if (dir === "up") for (const i of [...idx].reverse()) { if (i < p.els.length - 1) { [p.els[i], p.els[i + 1]] = [p.els[i + 1], p.els[i]]; } }
    if (dir === "down") for (const i of idx) { if (i > 0) { [p.els[i], p.els[i - 1]] = [p.els[i - 1], p.els[i]]; } }
  }
  commit(); renderAll();
}
/* ----------------------------- efeitos de texto ----------------------------- */
const FX_LABEL: Array<[string, string]> = [["", "Nenhum"], ["shadow", "Sombra"], ["outline", "Contorno"], ["hollow", "Vazado"], ["bg", "Fundo"], ["grad", "Degradê"]];
function textFxPanel(e: any): string {
  const fx: TextFx | undefined = e.textFx;
  const hex = (c: string | undefined, fb: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fb);
  const stops = fx?.stops ?? [["#ff5f6d", 0], ["#ffc371", 1]];
  const controls = !fx ? "" : fx.type === "grad"
    ? `<div class="row" style="gap:6px;margin-top:8px"><input type="color" id="fxG0" class="qcolor" value="${hex(stops[0][0], "#ff5f6d")}" title="Cor inicial"><input type="color" id="fxG1" class="qcolor" value="${hex(stops[stops.length - 1][0], "#ffc371")}" title="Cor final"></div>`
    : `<div class="row" style="gap:8px;margin-top:8px;align-items:center"><input type="color" id="fxColor" class="qcolor" value="${hex(fx.color, "#000000")}" title="Cor do efeito">
       <input type="range" id="fxSize" min="1" max="40" value="${Math.round(fx.size ?? Math.max(1, e.size / 20))}" style="flex:1" title="Intensidade"></div>`;
  return `<div class="sec"><h4>Efeitos</h4>
    <div class="grid3 fxgrid">${FX_LABEL.map(([k, l]) => `<button class="tile fxtile" data-fx="${k}" aria-pressed="${(fx?.type || "") === k}">${l}</button>`).join("")}</div>
    ${controls}
    <h4 style="margin-top:12px">Curvar</h4>
    <input type="range" id="fxCurve" min="-100" max="100" value="${Math.round(e.curve || 0)}" style="width:100%" title="Curvatura (0 = reto)">
  </div>`;
}
$("props").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-fx]");
  if (!b) return;
  const e = selEls()[0];
  if (!e || e.type !== "text") return;
  const type = b.dataset.fx as TextFx["type"] | "";
  const defaults: Record<string, TextFx> = {
    shadow: { type: "shadow", color: "#00000080", size: Math.max(2, Math.round(e.size / 18)) },
    outline: { type: "outline", color: "#000000", size: Math.max(1, Math.round(e.size / 24)) },
    hollow: { type: "hollow", color: e.fill || "#000000", size: Math.max(1, Math.round(e.size / 24)) },
    bg: { type: "bg", color: "#ffe066", size: Math.max(4, Math.round(e.size / 6)) },
    grad: { type: "grad", stops: [["#ff5f6d", 0], ["#ffc371", 1]], angle: 90 },
  };
  patch(type ? { textFx: e.textFx?.type === type ? e.textFx : defaults[type] } : { textFx: undefined }, true);
  renderProps();
});
$("props").addEventListener("input", (ev) => {
  const t = ev.target as HTMLInputElement;
  const e = selEls()[0];
  if (!e || e.type !== "text") return;
  if (t.id === "fxCurve") { const n = Math.round(Number(t.value)); patch({ curve: Math.abs(n) < 3 ? undefined : n }); return; }
  if (!e.textFx) return;
  if (t.id === "fxColor") patch({ textFx: { ...e.textFx, color: t.value } });
  if (t.id === "fxSize") patch({ textFx: { ...e.textFx, size: Number(t.value) } });
  if (t.id === "fxG0" || t.id === "fxG1") {
    const st = [...(e.textFx.stops ?? [["#ff5f6d", 0], ["#ffc371", 1]])] as Array<[string, number]>;
    if (t.id === "fxG0") st[0] = [t.value, 0]; else st[st.length - 1] = [t.value, 1];
    patch({ textFx: { ...e.textFx, stops: st } });
  }
});

/* ----------------------------- copiar estilo ----------------------------- */
let copiedStyle: CopiedStyle | null = null;
function armCopyStyle() {
  const e = selEls()[0];
  if (!e) return;
  if (copiedStyle) { copiedStyle = null; document.body.classList.remove("painting"); renderToolbar(); return; }
  copiedStyle = copyStyle(e);
  document.body.classList.add("painting");
  toast("Estilo copiado — clique no elemento que vai receber (Esc cancela)");
  renderToolbar();
}
function pasteCopiedStyleOnSelection() {
  if (!copiedStyle) return;
  let n = 0;
  for (const e of selEls()) if (pasteStyle(e, copiedStyle)) n++;
  if (n) { commit(); renderAll(); toast("Estilo aplicado"); }
}

/** Conta-gotas nativo do navegador (Chrome/Edge): a cor escolhida vira o preenchimento da
 *  seleção — do texto ou da forma. */
async function eyedrop() {
  try {
    const { sRGBHex } = await new (window as any).EyeDropper().open();
    const e = selEls()[0];
    if (!e) return;
    patch(e.grad ? { fill: sRGBHex, grad: undefined } : { fill: sRGBHex }, true);
    renderToolbar();
  } catch { /* cancelado */ }
}

function distributeSel(axis: "h" | "v") {
  const els = selEls().filter((e) => !e.locked);
  if (els.length < 3) { toast("Selecione 3 ou mais elementos para distribuir."); return; }
  distribute(els, axis);
  commit(); renderAll();
}

function align(how) {
  const els = selEls().filter((e) => !e.locked);
  if (!els.length) return;
  const b = els.length > 1 ? bbox(els) : (() => { const p = doc.pages[pageIdxOf(els[0].id)]; return { x: 0, y: 0, w: p.w, h: p.h }; })();
  for (const e of els) {
    if (how === "left") e.x = Math.round(b.x);
    if (how === "cx") e.x = Math.round(b.x + (b.w - e.w) / 2);
    if (how === "right") e.x = Math.round(b.x + b.w - e.w);
    if (how === "top") e.y = Math.round(b.y);
    if (how === "cy") e.y = Math.round(b.y + (b.h - e.h) / 2);
    if (how === "bottom") e.y = Math.round(b.y + b.h - e.h);
  }
  commit(); renderAll();
}
function flip(axis) {
  for (const e of selEls()) {
    // `e.pts` pode faltar num "draw" que só tem `fillPath` (sem stroke) — sem a guarda,
    // mapear undefined quebrava o flip pra qualquer elemento assim.
    if (e.type === "draw" && e.pts) e.pts = e.pts.map((p) => axis === "h" ? [1 - p[0], p[1]] : [p[0], 1 - p[1]]);
    // `fillPath` (path SVG arbitrário) ainda não espelha o próprio desenho — precisaria
    // reescrever cada par de coordenada dentro do `d`, não só mapear uma lista de pontos.
    // Sem produtor real de fillPath ainda (fica pro item 1.3/1.7 do backlog quando formas
    // vetoriais arbitrárias forem extraídas do PDF), não vale a complexidade agora.
    else e.rot = (e.rot + 180) % 360;
  }
  commit(); renderAll();
}
function patch(props: Partial<El>, immediate?: boolean) {
  for (const e of selEls()) Object.assign(e, props);
  renderCanvas();
  if (immediate) commit();
}



/* ============================ left rail + panels ============================ */
const TABS = [
  { id: "text", label: "Texto", icon: `<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>` },
  { id: "fonts", label: "Fontes", icon: `<path d="m3 17 4-10 4 10"/><path d="M4.5 13h5"/><circle cx="17" cy="14" r="3"/><path d="M20 11v6"/>` },
  { id: "elements", label: "Elementos", icon: `<path d="M8.3 10a.7.7 0 0 1-.63-1.02l3.7-6.3a.7.7 0 0 1 1.26 0l3.7 6.3A.7.7 0 0 1 15.7 10z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>` },
  { id: "uploads", label: "Uploads", icon: `<path d="M12 13v8"/><path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="m8 17 4-4 4 4"/>` },
  { id: "photos", label: "Fotos", icon: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>` },
  { id: "draw", label: "Desenho", icon: `<path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/><path d="M13.5 7.5l3 3"/>` },
  { id: "page", label: "Página", tip: "Página — fundo e tamanho", icon: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>` },
];
function renderRail() {
  $("rail").innerHTML = TABS.map((t) => `
    <button class="railbtn" data-tab="${t.id}" aria-pressed="${activeTab === t.id}" title="${(t as { tip?: string }).tip || t.label} (clique de novo para fechar)" aria-label="${t.label}">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
      ${t.label}
    </button>`).join("");
}
$("rail").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  setPanel(activeTab === b.dataset.tab ? null : b.dataset.tab);
});

function setPanel(tab: string | null) {
  if (editingId) stopEditing();
  activeTab = tab;
  renderRail(); renderPanel();
  if (tab === "fonts") void refreshGlobalFonts();
  if (fitView) zoomFit();
  else { clampView(); applyWorld(); renderOverlay(); }
}

let fontQuery = "";
let fontCategory: FontCategory | null = null;
let catalogRequested = false;

let globalFonts: DocFont[] = [];
let globalFontsLoading = false;
let globalFontsError = false;

async function refreshGlobalFonts() {
  if (globalFontsLoading) return;
  globalFontsLoading = true;
  globalFontsError = false;
  renderFontList();
  try { globalFonts = await fetchGlobalFonts(); }
  catch { globalFontsError = true; }
  finally { globalFontsLoading = false; renderFontList(); }
}

async function applyFontFamily(family: string) {
  const target = doc;
  const selected = [...sel];
  const fonts = withGlobalFontFamily(target.fonts ?? [], globalFonts, family);
  try { await loadDesignFonts({ ...target, fonts }); }
  catch { toast("Não foi possível carregar essa fonte. Tente novamente."); return; }
  if (doc !== target || selected.join() !== sel.join()) return;
  doc.fonts = fonts;
  patch({ font: family }, true);
  renderFontList();
  renderToolbar();
}

/**
 * Puxa as folhas do catálogo uma vez, na primeira abertura do painel. Fora daqui ninguém
 * precisa delas: o index.html já traz as famílias que um design em branco usa, e um design
 * importado carrega as suas por FontFace (designFontLoader).
 */
function ensureFontCatalogLoaded() {
  if (catalogRequested) return;
  catalogRequested = true;
  // As famílias auto-hospedadas (Chirp) não estão em folha nenhuma do Google — o @font-face
  // delas vem daqui, apontando para os arquivos que servimos em /fonts.
  const style = document.createElement("style");
  style.textContent = localFontFaceCss();
  document.head.appendChild(style);
  for (const href of catalogStylesheetUrls()) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
}

/** As famílias que este design carrega consigo — as resolvidas na importação de PDF. */
function docFontFamilies(): string[] {
  return designFamilies([
    ...(doc.fonts ?? []).map((f) => f.family),
    ...doc.pages.flatMap((p) => p.els.filter((e) => e.type === "text").map((e) => e.font)),
  ]);
}

function fontTile(family: string, current: string | undefined): string {
  return `<button class="fonttile" data-font="${esc(family)}" aria-pressed="${family === current}" title="Aplicar ${esc(fontLabel(family))}"
    style="font-family:${esc(JSON.stringify(family))},Inter,system-ui,sans-serif">${esc(fontLabel(family))}</button>`;
}

/** Só a lista, para digitar na busca não recriar (e desfocar) o próprio campo. */
function fontListHtml(): string {
  const current = selEls().find((e) => e.type === "text")?.font;
  const mine = fontQuery || fontCategory ? [] : docFontFamilies();
  const found = searchFontLibrary({ query: fontQuery, category: fontCategory });
  const query = fontQuery.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
  const shared = fontCategory ? [] : [...new Set(globalFonts.map(f => f.family))]
    .filter(f => fontLabel(f).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().includes(query));
  const status = globalFontsLoading ? `<p class="phint">Carregando fontes compartilhadas…</p>`
    : globalFontsError ? `<p class="phint">Não foi possível carregar as fontes compartilhadas.</p><button data-retry-fonts>Tentar novamente</button>` : "";
  if (!found.length && !mine.length && !shared.length) return status || `<p class="phint">Nenhuma fonte com esse nome.</p>`;
  return status
    + (shared.length ? `<div class="sec"><h4>Fontes compartilhadas</h4>${shared.map(f => fontTile(f, current)).join("")}</div>` : "")
    + (mine.length ? `<div class="sec"><h4>Neste design</h4>${mine.map((f) => fontTile(f, current)).join("")}</div>` : "")
    + (found.length ? `<div class="sec"><h4>Biblioteca</h4>${found.map((f) => fontTile(f.family, current)).join("")}</div>` : "");
}

function renderFontList() {
  const list = $("fontList");
  if (list) list.innerHTML = fontListHtml();
}

let fontUploadBusy = false;

/**
 * Sobe um .ttf/.otf escolhido no painel "Fontes" e deixa a família pronta pra usar: registra em
 * `doc.fonts` (mesmo formato que o import de PDF já usa, para o render do servidor achar a
 * face) e carrega o .woff2 no navegador via FontFace, para o texto já aparecer certo no canvas
 * — sem isso, a família ficaria só de nome, igual uma fonte da biblioteca nunca carregada.
 */
async function importarFonte(file: File, forOriginal: string | null = null, asFamily: string | null = null) {
  const target = doc;
  fontUploadBusy = true;
  renderPanel();
  try {
    const form = new FormData();
    form.append("font", file, file.name);
    // Completando uma família que o design já usa: o arquivo entra com o MESMO nome de família,
    // senão "New Spirit Regular" e "New Spirit Bold" viravam fontes diferentes e nunca se juntavam.
    if (asFamily) form.append("family", asFamily);
    const res = await fetch("/api/v1/fonts/upload", { method: "POST", body: form, credentials: "include" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error || `Não foi possível importar ${file.name}.`);
      return;
    }
    const raw: RegisteredFontFace = await res.json();
    const face = registeredDocFont(raw);
    globalFonts = [...globalFonts.filter(f => f.sha256 !== face.sha256), face];
    if (doc !== target) {
      toast(`Fonte "${fontLabel(face.family)}" salva na biblioteca compartilhada.`);
      return;
    }
    doc.fonts = [...(doc.fonts ?? []).filter(f => f.sha256 !== face.sha256), face];
    try { await loadDesignFonts(doc); }
    catch { toast("Fonte salva, mas não foi possível carregá-la agora."); }
    if (doc !== target) return;
    const pedida = forOriginal;
    if (pedida) {
      // Veio do aviso "fonte faltando": troca a substituta nas caixas daquela fonte do PDF.
      applyMissingFont(pedida, face.family);
    } else {
      const selecionado = selEls().find((e) => e.type === "text");
      if (selecionado) patch({ font: face.family }, true); else commit();
    }
    renderFontList();
    renderToolbar();
    toast(`Fonte "${fontLabel(face.family)}" importada.`);
  } catch {
    toast(`Não foi possível importar ${file.name}.`);
  } finally {
    fontUploadBusy = false;
    renderPanel();
  }
}

/* --------------------------- banco de imagens --------------------------- */
/**
 * Busca de fotos do Pexels. O editor nunca fala com api.pexels.com: a chave é do servidor, e a
 * foto escolhida chega pelo nosso domínio (/api/v1/stock) porque uma imagem de outra origem
 * contamina o <canvas> e faz a exportação inteira falhar.
 */
let stockQuery = "";
let shapeQuery = "";
/* Configuração da caneta do painel Desenho — vale para os próximos traços. */
const PEN_TYPES = [
  { id: "pen", n: "Caneta", width: 6, alpha: 1, icon: `<path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/><path d="M13.5 7.5l3 3"/>` },
  { id: "marker", n: "Marcador", width: 16, alpha: 1, icon: `<path d="M9 15l-4 4v2h4l4-4"/><path d="M9 15l7-11 4 4-11 7z"/>` },
  { id: "highlighter", n: "Marca-texto", width: 28, alpha: 0.4, icon: `<path d="M9 11l-6 6v3h9l3-3"/><path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>` },
];
const pen = { type: "pen", color: "#FFFFFF", width: 6, alpha: 1 };
let stockPhotos: Array<{ id: string; thumb: string; alt: string; photographer: string; pageUrl: string }> = [];
let stockState: "vazio" | "buscando" | "ok" | "erro" | "desligado" = "vazio";
let stockPage = 1;
let stockHasMore = false;
let stockBusca = 0;
let stockDebounce: ReturnType<typeof setTimeout> | undefined;

function stockListHtml(): string {
  if (stockState === "desligado") return `<p class="phint">O banco de imagens não está configurado neste servidor.</p>`;
  if (stockState === "erro") return `<p class="phint">Não foi possível buscar agora. Tente de novo.</p>`;
  if (stockState === "buscando" && !stockPhotos.length) return `<p class="phint">Buscando…</p>`;
  if (!stockPhotos.length) {
    return `<p class="phint">${stockQuery.trim() ? "Nenhuma foto com esse termo." : "Digite um termo para buscar."}</p>`;
  }
  return `<div class="stockgrid">${stockPhotos.map((photo) => `
    <button class="stocktile" data-stock="${esc(photo.id)}" title="Inserir foto de ${esc(photo.photographer || "autor desconhecido")}">
      <img src="${esc(photo.thumb)}" alt="${esc(photo.alt)}" loading="lazy">
      <span class="stockcredit">${esc(photo.photographer || "Pexels")}</span>
    </button>`).join("")}</div>`
    + (stockHasMore ? `<button class="tbtn ghost" id="stockMore" style="width:100%;height:30px;margin-top:6px;font-size:11.5px">Carregar mais</button>` : "");
}

function renderStockList() {
  const list = $("stockList");
  if (list) list.innerHTML = stockListHtml();
}

async function buscarStock(page = 1) {
  const termo = stockQuery.trim();
  // Cada busca carrega o seu número: uma resposta lenta de um termo já apagado não pode
  // sobrescrever o resultado do termo que a pessoa está vendo agora.
  const busca = ++stockBusca;
  if (!termo) { stockPhotos = []; stockState = "vazio"; stockHasMore = false; renderStockList(); return; }
  stockState = "buscando";
  if (page === 1) stockPhotos = [];
  renderStockList();
  try {
    const res = await fetch(`/api/v1/stock/photos?q=${encodeURIComponent(termo)}&page=${page}`, { credentials: "include" });
    if (busca !== stockBusca) return;
    if (res.status === 501) { stockState = "desligado"; renderStockList(); return; }
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    if (busca !== stockBusca) return;
    stockPage = page;
    stockPhotos = page === 1 ? body.photos : [...stockPhotos, ...body.photos];
    stockHasMore = Boolean(body.hasMore);
    stockState = "ok";
  } catch {
    if (busca !== stockBusca) return;
    stockState = "erro";
  }
  renderStockList();
}

async function inserirStock(id: string, tile: HTMLElement) {
  const photo = stockPhotos.find((p) => p.id === id);
  tile.setAttribute("aria-busy", "true");
  try {
    const res = await fetch(`/api/v1/stock/photos/${encodeURIComponent(id)}/file`, { credentials: "include" });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const src = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
    const img = await loadImg(src);
    const p = page();
    const s = Math.min(1, (p.w * 0.6) / img.width, (p.h * 0.6) / img.height);
    // O nome da camada carrega o crédito: a licença do Pexels pede o autor, e é ele que aparece
    // na lista de Camadas e nos campos do template para quem for usar o design depois.
    addEl("image", {
      src, w: Math.round(img.width * s), h: Math.round(img.height * s),
      name: photo?.photographer ? `Foto de ${photo.photographer}`.slice(0, 40) : "Foto do Pexels",
    });
    toast(photo?.photographer ? `Foto de ${photo.photographer} (Pexels)` : "Foto inserida");
  } catch {
    toast("Não foi possível inserir essa foto.");
  } finally {
    tile.removeAttribute("aria-busy");
  }
}

/** Campo "Cor": amostra clicável + o hex em texto ao lado (antes o rótulo dizia "Hex" sem mostrar o valor). */
function colorField(id, value) {
  return `<div class="field colorfield"><label for="${id}">Cor</label><input type="color" id="${id}" value="${value}"><span class="num hexval" data-hex-for="${id}">${String(value).toUpperCase()}</span></div>`;
}
function filterShapes() {
  const q = shapeQuery.trim().toLowerCase();
  let n = 0;
  document.querySelectorAll<HTMLElement>("#shapeList [data-add]").forEach((b) => { const ok = !q || b.dataset.name!.includes(q); b.hidden = !ok; if (ok) n++; });
  const empty = document.getElementById("shapeEmpty");
  if (empty) empty.hidden = n > 0;
}

function renderPanel() {
  const el = $("panel");
  el.classList.remove("pages-index");
  if (!activeTab) { el.hidden = true; return; }
  el.hidden = false;
  const P = page();
  if (activeTab === "text") {
    el.innerHTML = `<h4 class="ptitle" title="Dê duplo clique em qualquer texto da tela para editá-lo no lugar">Texto</h4>
      <button class="texttile" data-add="text" data-size="88" data-weight="700" title="Adicionar título" style="font-size:21px;font-weight:700">Título</button>
      <button class="texttile" data-add="text" data-size="52" data-weight="600" title="Adicionar subtítulo" style="font-size:16px;font-weight:600">Subtítulo</button>
      <button class="texttile" data-add="text" data-size="30" data-weight="400" title="Adicionar corpo de texto" style="font-size:13px">Corpo de texto</button>`;
  }
  if (activeTab === "fonts") {
    ensureFontCatalogLoaded();
    el.innerHTML = `<h4 class="ptitle" title="Clique numa fonte para aplicar ao texto selecionado">Fontes</h4>
      <button class="dropzone" id="pickFont" aria-busy="${fontUploadBusy}" title="Importar um arquivo .ttf ou .otf">
        ${fontUploadBusy ? "Importando…" : "Importar fonte (.ttf/.otf)…"}</button>
      <input class="fontsearch" id="fontSearch" type="search" placeholder="Buscar fonte…" aria-label="Buscar fonte" value="${esc(fontQuery)}">
      <div class="fontcats">${[{ id: null, label: "Todas" }, ...FONT_CATEGORIES].map((c) => `
        <button class="fontcat" data-fontcat="${c.id ?? ""}" aria-pressed="${fontCategory === c.id}">${c.label}</button>`).join("")}</div>
      <div id="fontList">${fontListHtml()}</div>`;
  }
  if (activeTab === "elements") {
    const shapes = [
      ["rect", "Retângulo", `<rect x="3" y="6" width="18" height="12" rx="2"/>`],
      ["ellipse", "Elipse", `<circle cx="12" cy="12" r="9"/>`],
      ["triangle", "Triângulo", `<polygon points="12,3 21,20 3,20"/>`],
      ["star", "Estrela", `<polygon points="12,3 14.6,9.3 21,9.9 16.2,14.2 17.6,20.5 12,17.2 6.4,20.5 7.8,14.2 3,9.9 9.4,9.3"/>`],
      ["line", "Linha", `<path d="M4 12h16"/>`],
    ];
    el.innerHTML = `<h4 class="ptitle">Formas</h4>
      <input class="fontsearch" id="shapeSearch" type="search" placeholder="Buscar formas…" aria-label="Buscar formas" value="${esc(shapeQuery)}">
      <div class="grid3 ptiles" id="shapeList">${shapes.map(([t, n, ic]) => `
        <button class="tile" data-add="${t}" data-name="${n.toLowerCase()}" title="Adicionar ${n.toLowerCase()}" aria-label="Adicionar ${n.toLowerCase()}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ic}</svg><span>${n}</span></button>`).join("")}</div>
      <p class="phint" id="shapeEmpty" hidden>Nenhuma forma com esse nome.</p>`;
    filterShapes();
  }
  if (activeTab === "uploads") {
    el.innerHTML = `<h4 class="ptitle">Uploads</h4>
      <button class="dropzone" id="pickImg" title="Enviar imagens deste dispositivo">Enviar imagens do dispositivo…</button>`;
  }
  if (activeTab === "photos") {
    el.innerHTML = `<h4 class="ptitle">Fotos</h4>
      <input class="fontsearch" id="stockSearch" type="search" placeholder="Buscar fotos…" aria-label="Buscar fotos no banco de imagens" value="${esc(stockQuery)}">
      <div class="sec"><h4>Banco de imagens <span class="phint" style="font-weight:400">· Pexels</span></h4>
        <div id="stockList">${stockListHtml()}</div>
      </div>`;
  }
  if (activeTab === "draw") {
    const drawing = tool === "draw";
    el.innerHTML = `<h4 class="ptitle">Desenho</h4>
      <div class="grid3 ptiles" role="radiogroup" aria-label="Tipo de caneta">${PEN_TYPES.map((t) => `
        <button class="tile" data-pen="${t.id}" role="radio" aria-checked="${pen.type === t.id}" aria-pressed="${pen.type === t.id}" title="${t.n}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg><span>${t.n}</span></button>`).join("")}</div>
      <div class="sec"><h4>Cor</h4>
        <div class="grid4" style="margin-bottom:8px">${PALETTE.slice(0, 8).map((c) => `<button class="swatch" data-pencolor="${c}" aria-pressed="${pen.color.toLowerCase() === c.toLowerCase()}" title="Cor ${c}" style="background:${c}"></button>`).join("")}</div>
        ${colorField("penColor", pen.color)}
      </div>
      <div class="sec"><h4>Espessura <span class="num pval" id="penWidthVal">${pen.width}</span></h4>
        <input type="range" id="penWidth" min="1" max="60" value="${pen.width}" aria-label="Espessura do traço">
        <h4 style="margin-top:10px">Transparência <span class="num pval" id="penAlphaVal">${Math.round((1 - pen.alpha) * 100)}%</span></h4>
        <input type="range" id="penAlpha" min="0" max="90" value="${Math.round((1 - pen.alpha) * 100)}" aria-label="Transparência do traço">
      </div>
      <button class="tbtn primary pdraw" id="drawOn" aria-pressed="${drawing}" title="${drawing ? "Parar de desenhar (Esc)" : "Começar a desenhar (P)"}">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${drawing ? `<rect x="6" y="6" width="12" height="12" rx="2"/>` : `<path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/>`}</svg>
        ${drawing ? "Parar de desenhar" : "Começar a desenhar"}</button>`;
  }
  if (activeTab === "page") {
    el.innerHTML = `<h4 class="ptitle">Página <span class="phint" style="font-weight:400">· fundo e tamanho da página ${doc.active + 1}</span></h4>
      <div class="sec"><h4>Fundo</h4>
        <div class="grid4" style="margin-bottom:8px">${PALETTE.slice(0, 8).map((c) => `<button class="swatch" data-bg="${c}" aria-pressed="${P.bg.toLowerCase() === c}" title="Fundo da página ${c}" style="background:${c}"></button>`).join("")}</div>
        ${colorField("bgPick", /^#[0-9a-f]{6}$/i.test(P.bg) ? P.bg : "#ffffff")}
        <h4 style="margin-top:10px">Degradê</h4>
        <div class="grid4" style="margin-bottom:8px">${BG_GRADS.map(([a, b, ang], i) => `<button class="swatch" data-bggrad="${i}" title="Fundo em degradê" style="background:linear-gradient(${ang}deg,${a},${b})"></button>`).join("")}</div>
        ${P.bgImage ? `<div class="row" style="margin-bottom:8px"><button class="tbtn ghost" data-bgimg-clear style="flex:1;height:30px;font-size:11.5px">Remover imagem de fundo</button></div>`
          : `<p class="phint">Imagem de fundo: selecione uma imagem e use <b>Usar como fundo</b> na barra.</p>`}
      </div>
      <div class="sec"><h4 title="A área ao redor da página — não o conteúdo dela">Fundo do canvas</h4>
        <div class="grid4" style="margin-bottom:8px">${STAGE_BG_PRESETS.map((c) => `<button class="swatch" data-stagebg="${c}" aria-pressed="${(stageBg || "").toLowerCase() === c.toLowerCase()}" title="Fundo do canvas ${c}" style="background:${c}"></button>`).join("")}</div>
        <div class="row" style="margin-bottom:8px"><button class="tbtn ghost" data-stagebg-reset style="flex:1;height:30px;font-size:11.5px" aria-pressed="${!stageBg}">Seguir o tema</button></div>
        ${colorField("stageBgPick", stageBg || stageGroundHex())}
      </div>
      <div class="sec"><h4 title="Aplica a todas as páginas do documento">Tamanho</h4>
        <div class="grid2" style="margin-bottom:8px">${PAGE_SIZES.map((s) => `<button class="tile sizetile" data-size="${s.w}x${s.h}" title="${s.n} — ${s.w}×${s.h}"><span>${s.n}</span><span class="num">${s.w}×${s.h}</span></button>`).join("")}</div>
        <div class="row"><div class="field"><label>L</label><input class="num" id="pgW" value="${P.w}"></div><div class="field"><label>A</label><input class="num" id="pgH" value="${P.h}"></div></div>
      </div>`;
  }
  el.insertAdjacentHTML("afterbegin", `<button class="panel-close" data-close-panel title="Fechar painel" aria-label="Fechar painel">×</button>`);
}

/* Reference: /Users/it4mi/Downloads/canva/painel-posicao.html.
 * This list reflects paint order: the first visible row is the frontmost element. */
function renderLayers() {
  if (panelTab !== "layers") return;
  const box = $("props");
  if (box.classList.contains("layer-dragging")) return;
  const scrollTop = box.scrollTop;
  const P = page();
  const cur = selEls();
  const hit = (a: El, b: El) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const shown = layerFilter === "overlap" && cur.length ? P.els.filter((e) => cur.some((c) => c.id === e.id || hit(c, e))) : P.els;
  box.innerHTML = `<div class="layer-filter" role="group" aria-label="Filtrar camadas">
      <button class="chip" data-layerfilter="all" aria-pressed="${layerFilter === "all"}" title="Mostrar todas as camadas">Todas</button>
      <button class="chip" data-layerfilter="overlap" aria-pressed="${layerFilter === "overlap"}" title="Só as camadas que se sobrepõem à seleção">Sobrepostas</button>
    </div>
    <span id="layerDragHint" hidden>Arraste para reordenar; o topo da lista fica na frente. Ou use Alt + ↑ / ↓ na alça. Duplo clique no nome para renomear.</span>` +
    `<div class="layer-list" role="list" aria-label="Camadas da página ${doc.active + 1}">` +
    (shown.length ? [...shown].reverse().map((e) => {
      const scale = Math.min(32 / Math.max(1, e.w), 32 / Math.max(1, e.h));
      return `<div class="layer${e.hidden ? " is-hidden" : ""}" data-layer="${esc(e.id)}" data-selected="${sel.includes(e.id)}" role="listitem">
        <button class="layer-grip" data-layer-grip="${esc(e.id)}" aria-label="Arrastar camada ${esc(e.name)}" aria-describedby="layerDragHint" title="${e.locked ? "Desbloqueie para reordenar" : "Arraste para reordenar (o topo fica na frente) · Alt + ↑ / ↓"}" aria-disabled="${e.locked}">
          <svg width="12" height="20" viewBox="0 0 12 20" fill="currentColor"><circle cx="3" cy="5" r="1.2"/><circle cx="9" cy="5" r="1.2"/><circle cx="3" cy="10" r="1.2"/><circle cx="9" cy="10" r="1.2"/><circle cx="3" cy="15" r="1.2"/><circle cx="9" cy="15" r="1.2"/></svg>
        </button>
        <button class="layer-select" aria-label="Selecionar camada ${esc(e.name)}" aria-pressed="${sel.includes(e.id)}">
          <span class="layer-preview" aria-hidden="true"><span class="layer-preview-art" style="width:${e.w}px;height:${e.h}px;left:${(40 - e.w * scale) / 2}px;top:${(40 - e.h * scale) / 2}px;transform:scale(${scale})">${elInner(e)}</span></span>
          <span class="lname" data-rename="${esc(e.id)}" title="${esc(e.name)} — duplo clique para renomear">${esc(e.name)}<small>${TYPE_PT[e.type] || "Elemento"}${e.group ? " · grupo" : ""}${e.locked ? " · bloqueada" : ""}</small></span>
        </button>
        <button class="mini${e.locked ? " on" : ""}" data-layer-lock="${esc(e.id)}" title="${e.locked ? "Desbloquear" : "Bloquear"}" aria-label="${e.locked ? "Desbloquear" : "Bloquear"} camada ${esc(e.name)}">${LOCK_ICON(e.locked)}</button>
        <button class="mini${e.hidden ? " on" : ""}" data-hide="${esc(e.id)}" title="${e.hidden ? "Mostrar" : "Ocultar"}" aria-label="${e.hidden ? "Mostrar" : "Ocultar"} camada ${esc(e.name)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${e.hidden ? PAGE_MINI.hideOff : PAGE_MINI.hideOn}</svg>
        </button>
        <button class="mini" data-layermenu="${esc(e.id)}" title="Menu da camada" aria-label="Menu da camada ${esc(e.name)}">${MORE_ICON}</button>
      </div>`;
    }).join("") : `<p class="empty">Esta página está vazia. Adicione texto ou uma forma pela barra lateral.</p>`) + `</div>`;
  box.scrollTop = scrollTop;
}

function commitLayerDrop(ids: string[], targetId: string, side: LayerDropSide) {
  const P = page();
  const reordered = reorderLayers(P.els, ids, targetId, side);
  if (reordered === P.els) return;
  P.els = reordered;
  sel = ids;
  commit(); renderAll();
  const handle = [...(document.getElementById("props")!).querySelectorAll<HTMLButtonElement>("[data-layer-grip]")].find(node => node.dataset.layerGrip === ids[ids.length - 1]);
  handle?.focus({ preventScroll: true });
  $("layerAnnouncement").textContent = ids.length === 1 ? "Camada reordenada." : `${ids.length} camadas reordenadas.`;
}
attachLayerDrag($("props"), {
  getMovingIds: id => draggedLayerIds(page().els, id, sel),
  drop: commitLayerDrop,
});
$("props").addEventListener("keydown", (ev: KeyboardEvent) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>("[data-layer]");
  if (!row) return;
  // Arrows inside this list must never nudge the artwork on the canvas.
  if (ev.key.startsWith("Arrow")) ev.stopPropagation();
  if (!ev.altKey || !["ArrowUp", "ArrowDown"].includes(ev.key)) return;
  ev.preventDefault();
  const ids = draggedLayerIds(page().els, row.dataset.layer, sel);
  if (!ids.length) return;
  const list = [...page().els].reverse();
  const source = list.findIndex(el => el.id === row.dataset.layer);
  const direction = ev.key === "ArrowUp" ? -1 : 1;
  for (let i = source + direction; i >= 0 && i < list.length; i += direction) {
    if (ids.includes(list[i].id)) continue;
    commitLayerDrop(ids, list[i].id, direction < 0 ? "before" : "after");
    break;
  }
});

$("panel").addEventListener("click", (ev) => {
  if (ev.target.closest("[data-close-panel]")) { setPanel(null); return; }
  const dupPage = ev.target.closest("[data-duppage]");
  if (dupPage) { duplicatePage(+dupPage.dataset.duppage); return; }
  const delPage = ev.target.closest("[data-delpage]");
  if (delPage) { deletePage(+delPage.dataset.delpage); return; }
  const upPage = ev.target.closest("[data-moveuppage]");
  if (upPage) { movePageUp(+upPage.dataset.moveuppage); return; }
  const downPage = ev.target.closest("[data-movedownpage]");
  if (downPage) { movePageDown(+downPage.dataset.movedownpage); return; }
  const hidePage = ev.target.closest("[data-hidepage]");
  if (hidePage) { togglePageHidden(+hidePage.dataset.hidepage); return; }
  const add = ev.target.closest("[data-add]");
  if (add) {
    const t = add.dataset.add;
    const over: Partial<El> = {};
    if (add.dataset.size) over.size = +add.dataset.size;
    if (add.dataset.weight) over.weight = +add.dataset.weight;
    if (t === "text") over.text = add.textContent.trim();
    addEl(t, over);
    // Narrow screens use an overlay library; reveal the object after inserting it.
    if ($("view-editor").clientWidth <= 760) setPanel(null);
    return;
  }
  const bg = ev.target.closest("[data-bg]");
  if (bg) { page().bg = bg.dataset.bg; delete page().bgGrad; commit(); renderAll(); return; }
  const bgg = ev.target.closest("[data-bggrad]");
  if (bgg) {
    const [a, b, angle] = BG_GRADS[+bgg.dataset.bggrad];
    page().bgGrad = { type: "linear", angle, stops: [[a, 0], [b, 1]] }; page().bg = a;
    commit(); renderAll(); return;
  }
  if (ev.target.closest("[data-bgimg-clear]")) { delete page().bgImage; commit(); renderAll(); return; }
  if (ev.target.closest("[data-stagebg-reset]")) { stageBg = null; applyStageBg(); renderPanel(); return; }
  const sbg = ev.target.closest("[data-stagebg]");
  if (sbg) { stageBg = sbg.dataset.stagebg; applyStageBg(); renderPanel(); return; }
  const sz = ev.target.closest("[data-size]:not([data-add])");
  if (sz) {
    const [w, h] = sz.dataset.size.split("x").map(Number);
    for (const p of doc.pages) { p.w = w; p.h = h; }
    commit(); renderAll(); zoomFit(); return;
  }
  if (ev.target.closest("[data-retry-fonts]")) { void refreshGlobalFonts(); return; }
  const font = ev.target.closest("[data-font]");
  if (font) {
    void applyFontFamily(font.dataset.font);
    return;
  }
  const cat = ev.target.closest("[data-fontcat]");
  if (cat) {
    fontCategory = (cat.dataset.fontcat || null) as FontCategory | null;
    renderPanel();
    return;
  }
  if (ev.target.closest("#pickImg")) { $("fileImg").click(); return; }
  if (ev.target.closest("#pickFont")) { if (!fontUploadBusy) $("fileFont").click(); return; }
  const stockTile = ev.target.closest("[data-stock]");
  if (stockTile) { void inserirStock(stockTile.dataset.stock, stockTile); return; }
  if (ev.target.closest("#stockMore")) { void buscarStock(stockPage + 1); return; }
  if (ev.target.closest("#drawOn")) { setTool(tool === "draw" ? "select" : "draw"); return; }
  const penBtn = ev.target.closest("[data-pen]");
  if (penBtn) {
    const t = PEN_TYPES.find((x) => x.id === penBtn.dataset.pen)!;
    Object.assign(pen, { type: t.id, width: t.width, alpha: t.alpha });
    renderPanel(); return;
  }
  const penSw = ev.target.closest("[data-pencolor]");
  if (penSw) { pen.color = penSw.dataset.pencolor; renderPanel(); return; }
});
$("panel").addEventListener("input", (ev) => {
  // Só a lista é redesenhada: um renderPanel() inteiro recriaria o próprio campo de busca e
  // o cursor sairia dele a cada tecla.
  if (ev.target.id === "fontSearch") { fontQuery = ev.target.value; renderFontList(); return; }
  if (ev.target.id === "shapeSearch") { shapeQuery = ev.target.value; filterShapes(); return; }
  if (ev.target.type === "color") { const hx = document.querySelector(`[data-hex-for="${ev.target.id}"]`); if (hx) hx.textContent = ev.target.value.toUpperCase(); }
  if (ev.target.id === "penColor") { pen.color = ev.target.value; return; }
  if (ev.target.id === "penWidth") { pen.width = +ev.target.value; $("penWidthVal").textContent = String(pen.width); return; }
  if (ev.target.id === "penAlpha") { pen.alpha = 1 - +ev.target.value / 100; $("penAlphaVal").textContent = `${ev.target.value}%`; return; }
  if (ev.target.id === "stockSearch") {
    // Debounce porque cada tecla aqui seria uma requisição ao provedor, que tem cota por hora.
    stockQuery = ev.target.value;
    clearTimeout(stockDebounce);
    stockDebounce = setTimeout(() => void buscarStock(1), 300);
    return;
  }
  if (ev.target.id === "bgPick") { page().bg = ev.target.value; delete page().bgGrad; renderCanvas(); }
  if (ev.target.id === "stageBgPick") { stageBg = ev.target.value; applyStageBg(); }
  if (ev.target.id === "pgW" || ev.target.id === "pgH") {
    const w = +$("pgW").value, h = +$("pgH").value;
    if (w > 20 && h > 20) { for (const p of doc.pages) { p.w = w; p.h = h; } renderCanvas(); }
  }
});
$("panel").addEventListener("change", (ev) => {
  if (["bgPick", "pgW", "pgH"].includes(ev.target.id)) commit();
});


/* ============================ properties ============================ */
function renderProps() {
  renderSelToolbar();
  renderToolbar();

  const tabs = $("ptabs");
  if (tabs) {
    (tabs.querySelectorAll("[data-ptab]") as NodeListOf<HTMLElement>).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ptab === panelTab)));
  }
  if (panelTab === "layers") { renderLayers(); return; }
  if (panelTab === "code") { renderCodePanel(); return; }
  if (panelTab === "effects") {
    const fe = selEls();
    if (fe.length === 1 && fe[0].type === "text") { $("props").innerHTML = textFxPanel(fe[0]); return; }
    panelTab = "organize";
    tabs?.querySelector('[data-ptab="organize"]')?.setAttribute("aria-pressed", "true");
  }

  const box = $("props");
  const els = selEls();
  if (!els.length) {
    box.innerHTML = `<p class="empty">Nada selecionado.</p>`;
    return;
  }
  const e = els[0];
  const one = els.length === 1;

  box.innerHTML = `
    ${one ? "" : `<div class="sec"><h4>${els.length} objetos selecionados</h4></div>`}

    <div class="sec"><h4>Organizar</h4>
      <div class="seg order-actions" style="margin-bottom:12px">
        ${[["up", "Para frente", `<path d="m18 15-6-6-6 6"/>`],
           ["down", "Para trás", `<path d="m6 9 6 6 6-6"/>`],
           ["front", "Para o topo", `<rect width="8" height="8" x="8" y="8" rx="2" fill="currentColor"/><path d="M4 10a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2"/><path d="M14 20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2"/>`],
           ["back", "Para o fundo", `<rect width="8" height="8" x="14" y="14" rx="2" fill="currentColor"/><rect width="8" height="8" x="2" y="2" rx="2" fill="currentColor"/><rect width="8" height="8" x="8" y="8" rx="2"/>`]]
          .map(([k, tip, ic]) => `<button data-order="${k}" title="${tip}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ic}</svg><span>${tip}</span></button>`).join("")}
      </div>
      <h4 class="align-label">${els.length > 1 ? "Alinhar seleção" : "Alinhar à página"}</h4><div class="seg align-actions" style="margin-bottom:12px">
        ${[["left", `<rect width="6" height="14" x="6" y="5" rx="2"/><rect width="6" height="10" x="16" y="7" rx="2"/><path d="M2 2v20"/>`],
           ["cx", `<rect width="6" height="14" x="2" y="5" rx="2"/><rect width="6" height="10" x="16" y="7" rx="2"/><path d="M12 2v20"/>`],
           ["right", `<rect width="6" height="14" x="2" y="5" rx="2"/><rect width="6" height="10" x="12" y="7" rx="2"/><path d="M22 2v20"/>`]]
          .map(([k, ic]) => `<button data-align="${k}" title="Alinhar ${PT_ALIGN[k]}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ic}</svg><span>${({left:"À esquerda",cx:"Ao centro",right:"À direita",top:"Em cima",cy:"No meio",bottom:"Embaixo"})[k]}</span></button>`).join("")}
        ${[["top", `<rect width="14" height="6" x="5" y="16" rx="2"/><rect width="10" height="6" x="7" y="6" rx="2"/><path d="M2 2h20"/>`],
           ["cy", `<rect width="14" height="6" x="5" y="16" rx="2"/><rect width="10" height="6" x="7" y="2" rx="2"/><path d="M2 12h20"/>`],
           ["bottom", `<rect width="14" height="6" x="5" y="12" rx="2"/><rect width="10" height="6" x="7" y="2" rx="2"/><path d="M2 22h20"/>`]]
          .map(([k, ic]) => `<button data-align="${k}" title="Alinhar ${PT_ALIGN[k]}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ic}</svg><span>${({left:"À esquerda",cx:"Ao centro",right:"À direita",top:"Em cima",cy:"No meio",bottom:"Embaixo"})[k]}</span></button>`).join("")}
      </div>
      ${els.length >= 3 ? `<h4 class="align-label">Espaçamento</h4><div class="seg align-actions" style="margin-bottom:12px">
        <button data-distribute="h" title="Distribuir na horizontal"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect width="4" height="14" x="3" y="5" rx="1"/><rect width="4" height="14" x="10" y="5" rx="1"/><rect width="4" height="14" x="17" y="5" rx="1"/></svg><span>Horizontal</span></button>
        <button data-distribute="v" title="Distribuir na vertical"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect width="14" height="4" x="5" y="3" rx="1"/><rect width="14" height="4" x="5" y="10" rx="1"/><rect width="14" height="4" x="5" y="17" rx="1"/></svg><span>Vertical</span></button>
      </div>` : ""}
    </div>

    ${one ? `<div class="sec"><h4>Avançados</h4>
      <div class="adv-grid">
        <div class="field" title="Largura, em px"><label for="pW">Largura</label><input id="pW" value="${Math.round(e.w)}"><span class="unit">px</span></div>
        <button class="ratiolock" id="pRatio" aria-pressed="${ratioLock}" title="Manter proporção" aria-label="Manter proporção"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
        <div class="field" title="${e.type === "text" ? "Altura — automática no texto, definida pelo conteúdo" : "Altura, em px"}"><label for="pH">Altura</label><input id="pH" value="${Math.round(e.h)}" ${e.type === "text" ? "disabled" : ""}><span class="unit">px</span></div>
        <div class="field" title="Distância da borda esquerda da página, em px"><label for="pX">X</label><input id="pX" value="${Math.round(e.x)}"><span class="unit">px</span></div>
        <span></span>
        <div class="field" title="Distância do topo da página, em px"><label for="pY">Y</label><input id="pY" value="${Math.round(e.y)}"><span class="unit">px</span></div>
        <div class="field" title="Rotação, em graus"><label for="pR">Rotação</label><input id="pR" value="${Math.round(e.rot)}"><span class="unit">°</span></div>
      </div></div>` : ""}`;
}

/** Painel de código (item 4.4 do backlog) — só leitura, o JSON do elemento selecionado com um
 *  botão de copiar. Escopo bem menor que o "handoff" do repo de referência (que mapeia pra
 *  arquivos-fonte reais de um app gerado) — aqui não existe geração de código por trás de um
 *  design, então "o que essa camada é" já é o próprio JSON dela, não uma referência a outra
 *  coisa. Útil pra depurar um layout importado ou copiar um elemento pra outro design colando
 *  fora do app. */
function renderCodePanel() {
  const box = $("props");
  const els = selEls();
  if (!els.length) {
    box.innerHTML = `<p class="empty">Selecione um elemento pra ver o JSON dele.</p>`;
    return;
  }
  const json = els.length === 1 ? JSON.stringify(els[0], null, 2) : JSON.stringify(els, null, 2);
  box.innerHTML = `
    <div class="sec">
      <h4>${els.length === 1 ? "Elemento selecionado" : `${els.length} elementos selecionados`}</h4>
      <button class="tbtn ghost" id="codeCopyBtn" style="margin-bottom:8px">Copiar JSON</button>
      <pre id="codeJson" style="white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:11px;background:var(--surface-2);border-radius:8px;padding:10px;max-height:420px;overflow:auto">${esc(json)}</pre>
    </div>`;
}
$("props").addEventListener("click", (ev) => {
  if (!(ev.target as HTMLElement).closest("#codeCopyBtn")) return;
  const text = $("codeJson")?.textContent || "";
  navigator.clipboard?.writeText(text).then(() => toast("JSON copiado")).catch(() => {});
});

$("ptabs")?.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-ptab]");
  if (!b) return;
  panelTab = b.dataset.ptab as "organize" | "layers" | "code";
  renderProps();
});
$("closeProps").addEventListener("click", () => { propPopOpen = false; renderToolbar(); positionFloatingUI(); });
$("props").addEventListener("dblclick", (ev) => {
  const span = (ev.target as HTMLElement).closest<HTMLElement>("[data-rename]");
  if (!span) return;
  const el = byId(span.dataset.rename);
  if (!el) return;
  const input = document.createElement("input");
  input.className = "lrename"; input.value = el.name; input.setAttribute("aria-label", "Nome da camada");
  span.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = (save: boolean) => { if (done) return; done = true; const v = input.value.trim(); if (save && v && v !== el.name) { el.name = v.slice(0, 80); commit(); } renderLayers(); };
  input.addEventListener("keydown", (k) => { k.stopPropagation(); if (k.key === "Enter") finish(true); if (k.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (c) => c.stopPropagation());
  input.addEventListener("pointerdown", (c) => c.stopPropagation());
});
$("props").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const lf = t.closest<HTMLElement>("[data-layerfilter]");
  if (lf) { layerFilter = lf.dataset.layerfilter as "all" | "overlap"; renderLayers(); return; }
  const lockBtn = t.closest<HTMLElement>("[data-layer-lock]");
  if (lockBtn) { const el = byId(lockBtn.dataset.layerLock); if (el) { el.locked = !el.locked; commit(); renderAll(); } return; }
  const hideBtn = t.closest<HTMLElement>("[data-hide]");
  if (hideBtn) { const el = byId(hideBtn.dataset.hide); el.hidden = !el.hidden; commit(); renderAll(); return; }
  const menuBtn = t.closest<HTMLElement>("[data-layermenu]");
  if (menuBtn) {
    const id = menuBtn.dataset.layermenu;
    const r = menuBtn.getBoundingClientRect();
    if (!sel.includes(id)) { sel = [id]; renderAll(); }
    openContextMenu(r.right - 240, r.bottom + 4);
    return;
  }
  const layerRow = t.closest<HTMLElement>("[data-layer]");
  if (layerRow) {
    const id = layerRow.dataset.layer;
    sel = (ev as MouseEvent).shiftKey ? (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]) : [id];
    renderAll();
    return;
  }
  const g = (a: string) => t.closest<HTMLElement>(`[data-${a}]`);
  if (g("order")) return order(g("order").dataset.order);
  if (g("align")) return align(g("align").dataset.align);
  if (g("distribute")) return distributeSel(g("distribute").dataset.distribute as "h" | "v");
  if (t.closest("#pRatio")) { ratioLock = !ratioLock; renderProps(); return; }
});
$("props").addEventListener("input", (ev) => {
  const id = (ev.target as HTMLElement).id, v = (ev.target as HTMLInputElement).value, n = parseFloat(v);
  const map = {
    pX: () => patch({ x: n || 0 }), pY: () => patch({ y: n || 0 }),
    pW: () => { if (!(n > 0)) return; const e = selEls()[0]; if (ratioLock && e && e.type !== "text" && e.w > 0) { patch({ w: n, h: Math.round(n * e.h / e.w) }); const h = document.getElementById("pH") as HTMLInputElement | null; if (h) h.value = String(Math.round(selEls()[0].h)); } else patch({ w: n }); },
    pH: () => { if (!(n > 0)) return; const e = selEls()[0]; if (ratioLock && e && e.h > 0) { patch({ h: n, w: Math.round(n * e.w / e.h) }); const w = document.getElementById("pW") as HTMLInputElement | null; if (w) w.value = String(Math.round(selEls()[0].w)); } else patch({ h: n }); },
    pR: () => patch({ rot: n || 0 }),
  };
  if (map[id]) { map[id](); }
  if (["pW", "pH", "pR"].includes(id)) renderOverlay();
});
$("props").addEventListener("change", () => commit());


/* ============================ pages ============================ */
const thumbs = new Map<string, string>();
let thumbBusy = false;
async function buildThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    await document.fonts.ready;
    for (const p of doc.pages) {
      if (thumbs.has(p.id)) continue;
      const c = await renderPageCanvas(p, Math.min(1, 720 / p.w));
      thumbs.set(p.id, c.toDataURL("image/jpeg", 0.92));
      refreshPagesUI();
    }
  } catch (e) { /* a thumbnail is a nicety, never a blocker */ }
  thumbBusy = false;
}
const dirtyThumb = (id?: string) => { thumbs.delete(id || page().id); buildThumbs(); };

const PAGE_MINI = {
  up: `<path d="M18 15l-6-6-6 6"/>`,
  down: `<path d="M6 9l6 6 6-6"/>`,
  hideOn: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.6"/>`,
  hideOff: `<path d="M3 3l18 18"/><path d="M10.6 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.4 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.3 0 2.5-.3 3.6-.7"/>`,
  dup: `<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16V4a2 2 0 0 1 2-2h12"/><path d="M15 12v6M12 15h6"/>`,
  del: `<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>`,
  more: `<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`,
};
const pageMini = (action: string, icon: string, i: number, title: string, disabled = false) => `
  <button class="pmini${["moveuppage", "movedownpage", "hidepage"].includes(action) ? " page-secondary" : ""}" data-${action}="${i}" title="${title}" aria-label="${title}" ${disabled ? "disabled" : ""}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
  </button>`;

// Shared by the on-canvas page headers and thumbnail strip.
function addPage() {
  const last = doc.pages[doc.pages.length - 1];
  const p = blankPage(); p.w = last.w; p.h = last.h;
  doc.pages.push(p); doc.active = doc.pages.length - 1; sel = [];
  commit(); renderAll(); refreshPagesUI();
  scrollToPage(doc.active); applyWorld();
}
function duplicatePage(i: number) {
  const copy = structuredClone(doc.pages[i]);
  copy.id = uid();
  copy.els.forEach((e) => { e.id = uid(); });
  doc.pages.splice(i + 1, 0, copy);
  doc.active = i + 1; sel = [];
  commit(); renderAll(); buildThumbs(); refreshPagesUI();
  scrollToPage(doc.active); applyWorld();
}
function deletePage(i: number) {
  if (doc.pages.length <= 1) return;
  doc.pages.splice(i, 1);
  doc.active = clamp(doc.active, 0, doc.pages.length - 1); sel = [];
  commit(); renderAll(); refreshPagesUI();
}
function movePageUp(i: number) {
  if (i <= 0) return;
  [doc.pages[i - 1], doc.pages[i]] = [doc.pages[i], doc.pages[i - 1]];
  if (doc.active === i) doc.active = i - 1; else if (doc.active === i - 1) doc.active = i;
  commit(); renderCanvas(); refreshPagesUI();
}
function movePageDown(i: number) {
  if (i >= doc.pages.length - 1) return;
  [doc.pages[i], doc.pages[i + 1]] = [doc.pages[i + 1], doc.pages[i]];
  if (doc.active === i) doc.active = i + 1; else if (doc.active === i + 1) doc.active = i;
  commit(); renderCanvas(); refreshPagesUI();
}
function togglePageHidden(i: number) {
  doc.pages[i].hidden = !doc.pages[i].hidden;
  commit(); renderCanvas(); refreshPagesUI();
}
/** All page indexes navigate the same canvas, keeping the current zoom. */
function goToPage(i: number) {
  doc.active = i; sel = []; editingId = null;
  baseline = snap();
  renderAll(); scrollToPage(i); applyWorld(); refreshPagesUI();
}

$("pagestack").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#addPageCanvas")) { addPage(); return; }
  const dup = t.closest<HTMLElement>("[data-duppage]"); if (dup) { duplicatePage(+dup.dataset.duppage); return; }
  const del = t.closest<HTMLElement>("[data-delpage]"); if (del) { deletePage(+del.dataset.delpage); return; }
  const up = t.closest<HTMLElement>("[data-moveuppage]"); if (up) { movePageUp(+up.dataset.moveuppage); return; }
  const down = t.closest<HTMLElement>("[data-movedownpage]"); if (down) { movePageDown(+down.dataset.movedownpage); return; }
  const hide = t.closest<HTMLElement>("[data-hidepage]"); if (hide) { togglePageHidden(+hide.dataset.hidepage); return; }
  const more = t.closest<HTMLElement>("[data-pagemore]");
  if (more) { const r = more.getBoundingClientRect(); openPageMenu(+more.dataset.pagemore, r.left, r.bottom + 4); return; }
});
/** "Mais opções da página" reaproveita o #ctxmenu: ocultar, página em branco abaixo, excluir. */
function openPageMenu(i: number, x: number, y: number) {
  const p = doc.pages[i]; if (!p) return;
  ctxMenuOpen = true;
  const el = $("ctxmenu");
  el.innerHTML = `
    <button class="ctxitem" data-ctx="pghide" data-page="${i}">${ci(p.hidden ? PAGE_MINI.hideOn : PAGE_MINI.hideOff)}${p.hidden ? "Mostrar página" : "Ocultar página"}</button>
    <button class="ctxitem" data-ctx="pgadd" data-page="${i}">${ci(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6M12 12v6"/>`)}Adicionar página em branco abaixo</button>
    <div class="ctxsep"></div>
    <button class="ctxitem danger" data-ctx="pgdel" data-page="${i}" ${doc.pages.length > 1 ? "" : "disabled"}>${CI.del}Excluir página</button>`;
  el.hidden = false;
  el.style.left = x + "px"; el.style.top = y + "px";
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) el.style.left = Math.max(8, window.innerWidth - r.width - 8) + "px";
    if (r.bottom > window.innerHeight - 8) el.style.top = Math.max(8, y - r.height - 36) + "px";
  });
}
function insertBlankPageAfter(i: number) {
  const ref = doc.pages[i];
  const p = blankPage(); p.w = ref.w; p.h = ref.h;
  doc.pages.splice(i + 1, 0, p); doc.active = i + 1; sel = [];
  commit(); renderAll(); refreshPagesUI();
  scrollToPage(doc.active); applyWorld();
}

/* ---------- thumbnail strip ---------- */
function renderThumbStrip() {
  $("thumbstrip").innerHTML = doc.pages.map((p, i) => `
    <button class="thumbitem" data-gopage="${i}" aria-pressed="${i === doc.active}" aria-label="Página ${i + 1}" title="Página ${i + 1}${p.hidden ? " · oculta" : ""}">
      <div class="thumbitempic" style="background:${pageBgCss(p)}; aspect-ratio:${p.w}/${p.h}; opacity:${p.hidden ? .45 : 1}">${thumbs.has(p.id)
        ? `<img src="${thumbs.get(p.id)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
        : ""}</div>
      <span class="num">${i + 1}</span>
    </button>`).join("") +
    `<button class="thumbitem thumbadd" id="addPageThumb" title="Adicionar página">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    </button>`;
}
$("thumbstrip").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#addPageThumb")) { addPage(); return; }
  const item = t.closest<HTMLElement>("[data-gopage]");
  if (item) goToPage(+item.dataset.gopage);
});

/* ---------- how the pages are being viewed ----------
 * "document" is the canvas itself — the scrolling column — and therefore the resting state,
 * not something that has to be switched on. The strip and the grid are just navigation laid
 * over it; closing either drops you back into the document exactly where you were. */
function currentPagesMode(): "document" | "thumb" | "grid" {
  if (!$("gridview").hidden) return "grid";
  if (!$("thumbstrip").hidden) return "thumb";
  return "document";
}
function updatePagesModeButtons() {
  const m = currentPagesMode();
  $("thumbViewBtn").setAttribute("aria-pressed", String(m === "thumb"));
  $("gridViewBtn").setAttribute("aria-pressed", String(m === "grid"));
}
function refreshPagesUI() {
  if (!$("thumbstrip").hidden) renderThumbStrip();
  if (!$("gridview").hidden) renderGridView();
}
function setPagesMode(mode: "document" | "thumb" | "grid") {
  // Re-clicking the strip or the grid closes it, which is the same thing as going back to the
  // bare document — so both of those collapse to "document".
  const next = currentPagesMode() === mode ? "document" : mode;
  $("gridview").hidden = true;
  if (next === "document") $("thumbstrip").hidden = true;
  if (next === "thumb") { $("thumbstrip").hidden = false; renderThumbStrip(); }
  if (next === "grid") { renderGridView(); $("gridview").hidden = false; }
  updatePagesModeButtons();
  // Keep scale while the strip reserves its own space below the canvas.
  clampView(); applyWorld(); renderOverlay();
}
$("thumbViewBtn").addEventListener("click", () => setPagesMode("thumb"));
$("gridViewBtn").addEventListener("click", () => setPagesMode("grid"));
$("fullscreenBtn").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

/* ---------- grid view ---------- */
function renderGridView() {
  $("gridview").innerHTML = doc.pages.map((p, i) => `
    <button class="gridcell" data-gridpage="${i}" aria-pressed="${i === doc.active}" title="Abrir página ${i + 1}">
      <div class="pt" style="background:${pageBgCss(p)}; aspect-ratio:${p.w}/${p.h}; opacity:${p.hidden ? .45 : 1}">${thumbs.has(p.id)
        ? `<img src="${thumbs.get(p.id)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
        : ""}</div>
      <span class="plabel">Página ${i + 1}${p.hidden ? " · oculta" : ""}</span>
    </button>`).join("");
}
$("gridview").addEventListener("click", (ev) => {
  const cell = (ev.target as HTMLElement).closest<HTMLElement>("[data-gridpage]");
  if (!cell) { setPagesMode("document"); return; }
  const pageIdx = +cell.dataset.gridpage;
  setPagesMode("document");
  goToPage(pageIdx);
});

/* ---------- present mode ---------- */
let presentIdx = 0;
function presentablePages() {
  const list = doc.pages.filter((p) => !p.hidden);
  return list.length ? list : doc.pages;
}
async function renderPresentFrame() {
  const pages = presentablePages();
  presentIdx = clamp(presentIdx, 0, pages.length - 1);
  const c = await renderPageCanvas(pages[presentIdx], Math.min(2, 1600 / pages[presentIdx].w));
  ($("presentImg") as HTMLImageElement).src = c.toDataURL("image/png");
}
async function enterPresent() {
  presentIdx = Math.max(0, presentablePages().indexOf(page()));
  $("present").hidden = false;
  await renderPresentFrame();
  document.documentElement.requestFullscreen?.().catch(() => {});
}
function exitPresent() {
  $("present").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
$("presentBtn").addEventListener("click", enterPresent);
$("presentExit").addEventListener("click", exitPresent);
$("presentPrev").addEventListener("click", () => { presentIdx--; renderPresentFrame(); });
$("presentNext").addEventListener("click", () => { presentIdx++; renderPresentFrame(); });
$("present").addEventListener("click", (ev) => { if (ev.target === $("present")) exitPresent(); });



/* ============================ export ============================ */
interface GenerationReviewState {
  id: string;
  reviewStatus: "draft" | "pending" | "changes_requested" | "approved" | "rejected";
  version: number;
  approvedVersion: number | null;
  canDownload: boolean;
}

let generationReview: GenerationReviewState | null = null;
let reviewActionRunning = false;
let legacyGeneratedDesign = false;

const REVIEW_LABELS: Record<GenerationReviewState["reviewStatus"], string> = {
  draft: "Rascunho",
  pending: "Aguardando aprovação",
  changes_requested: "Ajustes solicitados",
  approved: "Aprovado",
  rejected: "Rejeitado",
};

function looksGenerated(id: string | undefined): boolean {
  return Boolean(id?.startsWith("generation-"));
}

function renderGenerationReview() {
  const controls = $("reviewControls");
  const managedGeneration = looksGenerated(doc.seedId) && !legacyGeneratedDesign;
  controls.hidden = !managedGeneration;
  $("exportBtn").hidden = managedGeneration && !generationReview?.canDownload;
  if (!managedGeneration) return;
  const status = $("reviewStatus");
  status.textContent = generationReview ? REVIEW_LABELS[generationReview.reviewStatus] : "Carregando revisão…";
  status.dataset.state = generationReview?.reviewStatus ?? "loading";
  $("submitReviewBtn").hidden = !generationReview || !["draft", "changes_requested", "rejected"].includes(generationReview.reviewStatus);
  $("approveBtn").hidden = generationReview?.reviewStatus !== "pending";
  $("requestChangesBtn").hidden = generationReview?.reviewStatus !== "pending";
  for (const id of ["submitReviewBtn", "approveBtn", "requestChangesBtn"]) $(id).disabled = reviewActionRunning;
}

async function refreshGenerationReview() {
  const designId = doc.seedId;
  generationReview = null;
  legacyGeneratedDesign = false;
  renderGenerationReview();
  if (!looksGenerated(designId)) return;
  try {
    const response = await fetch(`/api/v1/generations/by-design/${encodeURIComponent(designId!)}`, { credentials: "include" });
    if (response.status === 404) {
      legacyGeneratedDesign = true;
      renderGenerationReview();
      return;
    }
    if (!response.ok) throw new Error("review unavailable");
    const body = await response.json();
    if (doc.seedId !== designId) return;
    generationReview = body.generation as GenerationReviewState;
  } catch {
    if (doc.seedId === designId) toast("Não foi possível carregar o estado de aprovação.");
  }
  renderGenerationReview();
}

async function reviewAction(action: "submit" | "approve" | "request-changes") {
  if (!generationReview || reviewActionRunning) return;
  let comment: string | undefined;
  if (action === "request-changes") {
    comment = window.prompt("Quais ajustes precisam ser feitos?")?.trim();
    if (!comment) return;
  }
  reviewActionRunning = true;
  renderGenerationReview();
  clearTimeout(persistTimer);
  try {
    if (!await syncTemplateToServer(doc)) throw new Error("Não foi possível salvar o design antes da decisão.");
    const response = await fetch(`/api/v1/generations/${encodeURIComponent(generationReview.id)}/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: generationReview.version, ...(comment ? { comment } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.error === "STALE_VERSION") throw new Error("O design mudou. Envie a versão atual para aprovação primeiro.");
      throw new Error(body.message || body.error || "Não foi possível atualizar a aprovação.");
    }
    await refreshGenerationReview();
    toast(action === "approve" ? "Versão aprovada — downloads liberados." : action === "submit" ? "Enviado para aprovação." : "Ajustes solicitados.");
  } catch (err) {
    toast(err instanceof Error ? err.message : "Não foi possível atualizar a aprovação.");
    await refreshGenerationReview();
  } finally {
    reviewActionRunning = false;
    renderGenerationReview();
  }
}

$("submitReviewBtn").addEventListener("click", () => void reviewAction("submit"));
$("approveBtn").addEventListener("click", () => void reviewAction("approve"));
$("requestChangesBtn").addEventListener("click", () => void reviewAction("request-changes"));

let downloads = null;
if (window.claude?.use) {
  window.claude.use("downloads").then((d) => { downloads = d; }).catch(() => {});
}

/** Mesma forma que a capability `downloads` do runtime de Artifact ({filename, data} →
 *  Promise<void>), pra `doExport` não precisar de dois caminhos — só existe pra quando o app
 *  roda como site publicado de verdade (sem `window.claude`), que é o deploy de produção deste
 *  projeto. O tipo MIME vem da extensão do arquivo porque `data` chega em três formas diferentes
 *  (string do JSON, Uint8Array do PDF, Blob já tipado do canvas) e só o nome é comum às três. */
const DOWNLOAD_MIME_BY_EXT = { json: "application/json", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", html: "text/html", zip: "application/zip" };
async function browserDownload({ filename, data }) {
  const ext = filename.split(".").pop().toLowerCase();
  const blob = data instanceof Blob ? data : new Blob([data], { type: DOWNLOAD_MIME_BY_EXT[ext] || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoga tarde: Safari/Firefox iniciam o download de forma assíncrona — revogar cedo demais
  // corta o arquivo pela metade.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

let expFmt = "png", expScale = 2;
/** Com 2+ páginas visíveis o modal pergunta "todas ou só a atual" (padrão: todas, como no
 *  Canva). PNG/JPG de várias páginas saem num .zip só; PDF/HTML respeitam a mesma escolha. */
let expScope: "all" | "current" = "all";
let expBusy = false;
const isImageFmt = (f: string) => f === "png" || f === "jpg";

/** Páginas que a exportação atual vai gerar. Ocultas ficam de fora (igual PDF/apresentação);
 *  com uma página só visível, imagem continua sendo "a página em tela", como sempre foi. */
function exportPages(): Page[] {
  const pages = presentablePages();
  if (pages.length > 1) return expScope === "all" ? pages : [page()];
  return isImageFmt(expFmt) ? [page()] : pages;
}

function expThumb(p: Page, cls: string) {
  const src = thumbs.get(p.id);
  return `<span class="expthumb ${cls}" style="background:${esc(p.bg)};aspect-ratio:${+p.w}/${+p.h}">${src ? `<img src="${esc(src)}" alt="">` : ""}</span>`;
}

function renderExportScope() {
  const pages = presentablePages();
  const show = pages.length > 1 && expFmt !== "json";
  $("expPagesSec").hidden = !show;
  if (!show) return;
  const n = pages.length, cur = doc.active + 1, fmt = expFmt.toUpperCase();
  // Primeira página por cima: as de trás entram antes no DOM.
  const stack = pages.slice(0, 3).map((p, i) => expThumb(p, `s${i}`)).reverse().join("");
  const card = (scope: string, preview: string, title: string, sub: string) => `
    <button class="expcard" role="radio" data-scope="${scope}" aria-checked="${expScope === scope}">
      <span class="expstack">${preview}</span>
      <span class="exptitle">${title}</span>
      <span class="expsub">${sub}</span>
    </button>`;
  $("expScope").innerHTML =
    card("all", stack, "Todas as páginas", `${n} páginas`) +
    card("current", expThumb(page(), "s0"), "Página atual", `Página ${cur}`);
  $("expScopeHint").textContent = expScope === "current" ? `Só a página ${cur}, em ${fmt}.`
    : isImageFmt(expFmt) ? `${n} imagens ${fmt} num único arquivo .zip.`
    : expFmt === "pdf" ? `Um PDF com as ${n} páginas.`
    : `Uma página HTML com as ${n} telas.`;
}

/** PNG sem o fundo da página (logo, figurinha, sobreposição) — como o "fundo transparente" do Canva. */
let expTransparent = false;
$("expTransparent").addEventListener("change", (ev) => { expTransparent = (ev.target as HTMLInputElement).checked; });

const EXP_FMTS: [string, string, string][] = [
  ["png", "PNG", "Imagem de alta qualidade"],
  ["jpg", "JPG", "Arquivo de imagem pequeno"],
  ["pdf", "PDF", "Impressão e documentos"],
  ["json", "JSON", "Dados do design"],
  ["html", "HTML", "Página web"],
];
$("fmts").addEventListener("change", (ev) => { if (!expBusy) { expFmt = (ev.target as HTMLSelectElement).value; renderExport(); } });
$("scales").addEventListener("input", (ev) => { if (!expBusy) { expScale = +(ev.target as HTMLInputElement).value; renderExport(); } });
function renderExport() {
  $("fmts").innerHTML = EXP_FMTS.map(([f, label]) =>
    `<option value="${f}" ${expFmt === f ? "selected" : ""}>${label}${f === "png" ? " (sugerido)" : ""}</option>`).join("");
  $("fmtHint").textContent = EXP_FMTS.find(([f]) => f === expFmt)?.[2] || "";
  const sc = $("scales") as HTMLInputElement;
  sc.value = String(expScale);
  $("scaleVal").textContent = `${expScale}×`;
  $("scalePx").textContent = `${Math.round(page().w * expScale)} × ${Math.round(page().h * expScale)} px`;
  sc.parentElement!.style.display = (expFmt === "json") ? "none" : "";
  $("expTransparentRow").hidden = expFmt !== "png";
  ($("expTransparent") as HTMLInputElement).checked = expTransparent;
  renderExportScope();
}

/** Enquanto gera, o modal fica aberto com o progresso no botão — renderizar cada página a 2–3×
 *  leva centenas de ms, e fechar antes deixaria o usuário sem saber se algo está acontecendo. */
function setExportBusy(busy: boolean, label = "Baixar") {
  expBusy = busy;
  for (const id of ["expGo", "expCancel"]) ($(id) as HTMLButtonElement).disabled = busy;
  $("expGo").textContent = label;
  $("scrim").querySelector(".modal")!.classList.toggle("busy", busy);
}
function closeExport() { if (!expBusy) $("scrim").hidden = true; }

$("exportBtn").addEventListener("click", () => {
  if (looksGenerated(doc.seedId) && !legacyGeneratedDesign && !generationReview?.canDownload) {
    toast("A versão precisa ser aprovada antes do download.");
    return;
  }
  renderExport();
  $("scrim").hidden = false;
});
$("expCancel").addEventListener("click", closeExport);
$("scrim").addEventListener("click", (e) => { if (e.target === $("scrim")) closeExport(); });
$("scrim").addEventListener("click", (e) => {
  if (expBusy) return;
  const sc = e.target.closest("[data-scope]"); if (sc) { expScope = sc.dataset.scope; renderExportScope(); }
});
$("expGo").addEventListener("click", doExport);

async function loadImg(src: string): Promise<HTMLImageElement> {
  if (imgCache.has(src)) return imgCache.get(src);
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    // Without this, a remote image (anything not a data: URI) taints the canvas it's drawn
    // into — export/present/thumbnails then throw SecurityError on toDataURL/toBlob.
    if (!src.startsWith("data:")) i.crossOrigin = "anonymous";
    i.onload = () => res(i); i.onerror = rej; i.src = src;
  });
  imgCache.set(src, img);
  return img;
}

async function renderPageCanvas(p: Page, scale: number, opts: { transparent?: boolean } = {}) {
  const c = document.createElement("canvas");
  c.width = Math.round(p.w * scale); c.height = Math.round(p.h * scale);
  const x = c.getContext("2d");
  x.scale(scale, scale);
  if (!opts.transparent) {
    x.fillStyle = p.bgGrad ? paintOf(x, { w: p.w, h: p.h, grad: p.bgGrad, fill: p.bg }) : p.bg;
    x.fillRect(0, 0, p.w, p.h);
    if (p.bgImage) {
      try {
        const img = await loadImg(srcOf({ src: p.bgImage }));
        const r = Math.max(p.w / img.width, p.h / img.height);
        x.drawImage(img, (p.w - img.width * r) / 2, (p.h - img.height * r) / 2, img.width * r, img.height * r);
      } catch { /* imagem ilegível: fica a cor */ }
    }
  }
  for (const e of p.els) {
    if (e.hidden) continue;
    x.save();
    x.globalAlpha = e.opacity ?? 1;
    const fx = [];
    if (e.blur) fx.push(`blur(${e.blur * scale}px)`);
    if (e.filter) fx.push(e.filter);
    if (fx.length) x.filter = fx.join(" ");
    if (e.shadow) {
      // shadow offsets/blur live in device space, unaffected by ctx.scale
      x.shadowColor = e.shadow.color; x.shadowBlur = e.shadow.blur * scale;
      x.shadowOffsetX = e.shadow.x * scale; x.shadowOffsetY = e.shadow.y * scale;
    }
    x.translate(e.x + e.w / 2, e.y + e.h / 2);
    x.rotate(rad(e.rot));
    x.translate(-e.w / 2, -e.h / 2);
    if (e.clip) {
      x.beginPath();
      x.rect(e.clip.x - e.x, e.clip.y - e.y, e.clip.w, e.clip.h);
      x.clip();
    }
    await drawEl(x, e);
    x.restore();
  }
  return c;
}
/** stroke-dasharray do SVG para o estilo de contorno (em px do elemento). */
function dashAttr(e: any): string {
  const w = Number(e.strokeWidth) || 1;
  return e.strokeDash === "dashed" ? ` stroke-dasharray="${w * 3} ${w * 2}"` : e.strokeDash === "dotted" ? ` stroke-dasharray="0 ${w * 2}" stroke-linecap="round"` : "";
}
function canvasDash(x: CanvasRenderingContext2D, e: any) {
  const w = Number(e.strokeWidth) || 1;
  x.setLineDash(e.strokeDash === "dashed" ? [w * 3, w * 2] : e.strokeDash === "dotted" ? [0.01, w * 2] : []);
  x.lineCap = e.strokeDash === "dotted" ? "round" : "butt";
}
/** `Gradient` -> <linearGradient>/<radialGradient> em px do elemento, com a mesma geometria
 *  de `paintOf` (ângulo CSS: 0° para cima, horário) — o canvas e o SVG pintam igual. */
function svgGradient(id: string, e: any): string {
  const g = e.grad;
  const stops = g.stops.map(([c, p]: [string, number]) => `<stop offset="${Math.max(0, Math.min(1, p))}" stop-color="${c}"/>`).join("");
  if (g.type === "radial") return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${e.w / 2}" cy="${e.h / 2}" r="${Math.max(e.w, e.h) / 2}">${stops}</radialGradient>`;
  const a = ((g.angle || 0) * Math.PI) / 180;
  const len = Math.abs(e.w * Math.sin(a)) + Math.abs(e.h * Math.cos(a));
  const dx = (Math.sin(a) * len) / 2, dy = (-Math.cos(a) * len) / 2;
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${e.w / 2 - dx}" y1="${e.h / 2 - dy}" x2="${e.w / 2 + dx}" y2="${e.h / 2 + dy}">${stops}</linearGradient>`;
}
/** `Gradient` estruturado -> CSS (o que o DOM do editor pinta em `fill`). */
function gradToCss(g: any): string {
  const stops = g.stops.map(([c, p]: [string, number]) => `${c} ${(p * 100).toFixed(2)}%`).join(", ");
  return g.type === "radial" ? `radial-gradient(${stops})` : `linear-gradient(${g.angle || 0}deg, ${stops})`;
}
function paintOf(x: CanvasRenderingContext2D, e: any) {
  const g = e.grad;
  if (!g) return e.fill;
  let cg;
  if (g.type === "radial") {
    cg = x.createRadialGradient(e.w / 2, e.h / 2, 0, e.w / 2, e.h / 2, Math.max(e.w, e.h) / 2);
  } else {
    // CSS angle convention: 0deg points up, growing clockwise
    const a = ((g.angle || 0) * Math.PI) / 180;
    const len = Math.abs(e.w * Math.sin(a)) + Math.abs(e.h * Math.cos(a));
    const dx = (Math.sin(a) * len) / 2, dy = (-Math.cos(a) * len) / 2;
    cg = x.createLinearGradient(e.w / 2 - dx, e.h / 2 - dy, e.w / 2 + dx, e.h / 2 + dy);
  }
  for (const [c, p] of g.stops) cg.addColorStop(Math.max(0, Math.min(1, p)), c);
  return cg;
}
function roundRect(x, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  x.beginPath();
  x.moveTo(r, 0); x.lineTo(w - r, 0); x.quadraticCurveTo(w, 0, w, r);
  x.lineTo(w, h - r); x.quadraticCurveTo(w, h, w - r, h);
  x.lineTo(r, h); x.quadraticCurveTo(0, h, 0, h - r);
  x.lineTo(0, r); x.quadraticCurveTo(0, 0, r, 0); x.closePath();
}
function richFont(e: any, run: any): string {
  const weight = run.weight ?? e.weight;
  const italic = run.italic ?? e.italic;
  const font = run.font || e.font;
  return `${italic ? "italic " : ""}${weight} ${runSize(e, run)}px "${font}", Inter, system-ui, sans-serif`;
}
/** Corpo efetivo de um trecho: o próprio (escalado pelo autoFit, se houver) ou o do elemento. */
function runSize(e: any, run: any): number {
  return run.size ? run.size * (e.fitScale ?? 1) : e.size;
}

/** `runs` vira uma lista plana de tokens (uma palavra, ou `{break:true}` pra quebra de
 *  parágrafo) — mesma convenção de `split(" ")` que o texto plano já usa (espaço duplo não é
 *  preservado à risca, mesma limitação que sempre existiu). Cada palavra carrega o run de onde
 *  veio, pra medir/desenhar com a fonte certa. */
function tokenizeRuns(runs: any[]): any[] {
  // `glue`: o pedaço continua a palavra do run anterior (estilo aplicado no meio da palavra,
  // ex. "NEG" + "RITO") — não leva espaço antes nem quebra linha ali.
  const tokens: any[] = [];
  let prevEndsWord = false;
  for (const run of runs) {
    const paras = String(run.text).split("\n");
    paras.forEach((para, pi) => {
      if (pi > 0) { tokens.push({ brk: true }); prevEndsWord = false; }
      const words = para.split(" ");
      words.forEach((word, wi) => {
        if (word !== "") tokens.push({ text: word, run, glue: wi === 0 && prevEndsWord });
        prevEndsWord = wi === words.length - 1 && word !== "";
      });
    });
  }
  return tokens;
}

/** Desenha `e.runs` no canvas, com quebra de linha por palavra igual ao texto plano — só que
 *  cada palavra mede/desenha com a fonte/cor do PRÓPRIO run, não uma fonte só pra caixa
 *  inteira. Precisa remedir a largura de cada palavra (não só a linha inteira) porque uma
 *  palavra em negrito no meio da frase é mais larga que a mesma palavra sem negrito — ela pode
 *  empurrar a quebra de linha pra um ponto diferente do que o texto plano teria. */
/** Pinta um pedaço de texto com o efeito da caixa (sombra, contorno, vazado, degradê) — o
 *  mesmo resultado que o CSS de `textFxCss` dá no editor. */
function paintText(x: CanvasRenderingContext2D, e: any, text: string, px: number, py: number, color: string) {
  const fx = e.textFx;
  const n = Number(fx?.size) || Math.max(1, e.size / 20);
  x.save();
  if (fx?.type === "shadow") { x.shadowColor = fx.color || "#00000080"; x.shadowOffsetX = n; x.shadowOffsetY = n; x.shadowBlur = n * 1.5; }
  x.fillStyle = fx?.type === "grad"
    ? paintOf(x, { w: e.w, h: e.h, grad: { type: "linear", angle: fx.angle || 90, stops: fx.stops?.length ? fx.stops : [["#ff5f6d", 0], ["#ffc371", 1]] } })
    : color;
  if (fx?.type === "outline" || fx?.type === "hollow") {
    x.strokeStyle = fx.color || "#000"; x.lineJoin = "round";
    // CSS: -webkit-text-stroke centrado + paint-order stroke → metade fica por fora.
    x.lineWidth = fx.type === "outline" ? n * 2 : n;
    x.strokeText(text, px, py);
  }
  if (fx?.type !== "hollow") x.fillText(text, px, py);
  x.restore();
}

/** Texto curvo no canvas: cada letra no arco de `curveGeometry` (mesmo do SVG do editor). */
function drawCurvedText(x: CanvasRenderingContext2D, e: any) {
  const chars: Array<{ ch: string; run: any }> = [];
  const runs = e.runs?.length ? e.runs : [{ text: e.text }];
  for (const r of runs) for (const ch of String(r.text).replace(/\n/g, " ")) chars.push({ ch, run: r });
  const widths = chars.map(({ ch, run }) => { x.font = richFont(e, run); return x.measureText(ch).width; });
  const total = widths.reduce((a, b) => a + b, 0);
  // Arco com o comprimento do texto, centrado na caixa — igual ao SVG ajustado em fitTextElements.
  const g = curveGeometry(e.w, e.h, e.size, e.curve, total);
  let s = 0;
  x.textAlign = "center";
  chars.forEach(({ ch, run }, i) => {
    const mid = s + widths[i] / 2;
    const a = g.a0 + g.dir * (mid / g.r);
    x.save();
    x.translate(g.cx + g.r * Math.cos(a), g.cy + g.r * Math.sin(a));
    x.rotate(a + g.dir * Math.PI / 2);
    x.font = richFont(e, run);
    paintText(x, e, ch, 0, 0, run.fill || e.fill);
    x.restore();
    s += widths[i];
  });
  x.textAlign = "left";
}

/** Baseline (textBaseline "alphabetic") da linha `i` no mesmo modelo do CSS line-height:
 *  a área ascent+descent da fonte atual fica centrada na caixa de linha de altura `lh`. */
function cssBaseline(x: CanvasRenderingContext2D, i: number, lh: number): number {
  const m = x.measureText("Hg");
  const asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
  return i * lh + (lh - (asc + desc)) / 2 + asc;
}

function drawRichText(x: CanvasRenderingContext2D, e: any) {
  const tokens = tokenizeRuns(e.runs);
  const spaceWidth = (run: any) => { x.font = richFont(e, run); return x.measureText(" ").width; };
  const wordWidth = (tok: any) => { x.font = richFont(e, tok.run); return x.measureText(tok.text).width; };

  const lines: any[][] = [[]];
  const lineEndsPara: boolean[] = [];
  let width = 0;
  for (const tok of tokens) {
    if (tok.brk) { lineEndsPara[lines.length - 1] = true; lines.push([]); width = 0; continue; }
    const line = lines[lines.length - 1];
    const w = wordWidth(tok);
    const sep = line.length && !tok.glue ? spaceWidth(tok.run) : 0;
    if (line.length && !tok.glue && width + sep + w > e.w) {
      lines.push([tok]);
      width = w;
    } else {
      line.push(tok);
      width += sep + w;
    }
  }

  // Como no CSS: cada linha tem a altura do seu trecho mais alto (corpo × entrelinha), e a
  // baseline é a do trecho que mais sobe — uma palavra maior empurra só a própria linha.
  let top = 0;
  lines.forEach((line, li) => {
    let lineWidth = 0;
    line.forEach((tok, j) => { lineWidth += wordWidth(tok) + (j > 0 && !tok.glue ? spaceWidth(tok.run) : 0); });
    let cx = e.align === "center" ? (e.w - lineWidth) / 2 : e.align === "right" ? e.w - lineWidth : 0;
    // Justificado: a sobra vai para os espaços, exceto na última linha do parágrafo.
    const gaps = line.filter((tok, j) => j > 0 && !tok.glue).length;
    const lastOfPara = li === lines.length - 1 || lineEndsPara[li];
    const extra = e.align === "justify" && !lastOfPara && gaps ? (e.w - lineWidth) / gaps : 0;
    const runsInLine = line.length ? line.map((tok) => tok.run) : [{}];
    let ty = 0, lineH = 0;
    for (const run of runsInLine) {
      const lh = runSize(e, run) * e.lh;
      x.font = richFont(e, run);
      const m = x.measureText("Hg");
      const base = (lh - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
      ty = Math.max(ty, base); lineH = Math.max(lineH, lh);
    }
    ty += top; top += lineH;
    line.forEach((tok, j) => {
      if (j > 0 && !tok.glue) cx += spaceWidth(tok.run) + extra;
      x.font = richFont(e, tok.run);
      paintText(x, e, tok.text, cx, ty, tok.run.fill || e.fill);
      const w = x.measureText(tok.text).width;
      if (tok.run.underline ?? e.underline) x.fillRect(cx, ty + runSize(e, tok.run) * 0.12, w, Math.max(1, runSize(e, tok.run) / 16));
      if (tok.run.strike ?? e.strike) x.fillRect(cx, ty - runSize(e, tok.run) * 0.3, w, Math.max(1, runSize(e, tok.run) / 16));
      cx += w;
    });
  });
}

async function drawEl(x: CanvasRenderingContext2D, e: any) {
  const stroke = () => { if (e.stroke && e.strokeWidth) { x.strokeStyle = e.stroke; x.lineWidth = e.strokeWidth; canvasDash(x, e); x.stroke(); x.setLineDash([]); } };
  if (e.type === "rect") {
    if (e.ring) {
      const p = new Path2D();
      const rr = (px, py, pw, ph, r) => {
        r = Math.min(r, pw / 2, ph / 2);
        if (p.roundRect) p.roundRect(px, py, pw, ph, r); else p.rect(px, py, pw, ph);
      };
      rr(0, 0, e.w, e.h, e.radius || 0);
      rr(e.ring, e.ring, Math.max(0, e.w - e.ring * 2), Math.max(0, e.h - e.ring * 2), Math.max(0, (e.radius || 0) - e.ring));
      x.fillStyle = paintOf(x, e);
      x.fill(p, "evenodd");
    } else {
      roundRect(x, e.w, e.h, e.radius || 0); x.fillStyle = paintOf(x, e); x.fill(); stroke();
    }
  }
  else if (e.type === "ellipse") { x.beginPath(); x.ellipse(e.w / 2, e.h / 2, e.w / 2, e.h / 2, 0, 0, 7); x.fillStyle = paintOf(x, e); x.fill(); stroke(); }
  else if (e.type === "triangle") { x.beginPath(); x.moveTo(e.w / 2, 0); x.lineTo(0, e.h); x.lineTo(e.w, e.h); x.closePath(); x.fillStyle = e.fill; x.fill(); }
  else if (e.type === "star") {
    x.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? .5 : 1, a = (Math.PI / 5) * i - Math.PI / 2;
      const px = e.w / 2 + Math.cos(a) * (e.w / 2) * r, py = e.h / 2 + Math.sin(a) * (e.h / 2) * r;
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    }
    x.closePath(); x.fillStyle = e.fill; x.fill();
  }
  else if (e.type === "line") {
    x.fillStyle = paintOf(x, e);
    if (e.arrowStart || e.arrowEnd) {
      const { t, cy, x0, x1 } = lineGeom(e);
      x.fillRect(x0, 0, Math.max(0, x1 - x0), t);
      if (e.arrowStart) x.fill(new Path2D(lineEndPath(e.arrowStart, 0, cy, t, -1)));
      if (e.arrowEnd) x.fill(new Path2D(lineEndPath(e.arrowEnd, e.w, cy, t, 1)));
    } else { roundRect(x, e.w, e.h, e.h / 2); x.fill(); }
  }
  else if (e.type === "icon") {
    const vb = String(e.viewBox || "0 0 24 24").split(/[\s,]+/).map(Number);
    x.save();
    x.scale(e.w / (vb[2] || 24), e.h / (vb[3] || 24));
    x.translate(-(vb[0] || 0), -(vb[1] || 0));
    x.fillStyle = e.fill;
    try { x.fill(new Path2D(e.path || "")); } catch (err) { /* malformed path */ }
    x.restore();
  }
  else if (e.type === "draw") {
    if (e.fillPath) {
      try {
        const p = new Path2D();
        p.addPath(new Path2D(e.fillPath), new DOMMatrix().scale(e.w, e.h));
        if (e.grad) { x.save(); x.clip(p, e.fillRule === "evenodd" ? "evenodd" : "nonzero"); x.fillStyle = paintOf(x, e); x.fillRect(0, 0, e.w, e.h); x.restore(); }
        else if (e.fill && e.fill !== "none") { x.fillStyle = e.fill; x.fill(p, e.fillRule === "evenodd" ? "evenodd" : "nonzero"); }
        if (e.stroke && e.strokeWidth) { x.strokeStyle = e.stroke; x.lineWidth = e.strokeWidth; canvasDash(x, e); x.stroke(p); x.setLineDash([]); }
      } catch (err) { /* malformed path */ }
    }
    if (e.pts && e.pts.length) {
      x.beginPath();
      e.pts.forEach((p, i) => { const px = p[0] * e.w, py = p[1] * e.h; i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.strokeStyle = e.stroke; x.lineWidth = e.strokeWidth; x.lineCap = "round"; x.lineJoin = "round"; x.stroke();
    }
  }
  else if (e.type === "image" && srcOf(e)) {
    try {
      const img = await loadImg(srcOf(e));
      x.save(); roundRect(x, e.w, e.h, e.radius || 0); x.clip();
      if (e.imgW == null || e.imgH == null) {
        const r = Math.max(e.w / img.width, e.h / img.height);
        const dw = img.width * r, dh = img.height * r;
        x.drawImage(img, (e.w - dw) / 2, (e.h - dh) / 2, dw, dh);
      } else {
        const { sx, sy, sw, sh: srcH } = cropToSourceRect(e, img.width, img.height);
        x.drawImage(img, sx, sy, sw, srcH, 0, 0, e.w, e.h);
      }
      x.restore(); stroke();
    } catch (err) { /* unreadable image, skip */ }
  }
  else if (e.type === "text") {
    if (e.autoFit) {
      const measure = document.createElement("div");
      measure.style.cssText = `position:absolute;left:-10000px;top:0;width:${Number(e.w)}px;visibility:hidden`;
      measure.innerHTML = editorTextHtml(e);
      document.body.appendChild(measure);
      try {
        fitTextElements(measure);
        const fitted = parseFloat((measure.firstElementChild as HTMLElement).style.fontSize);
        // Trechos com corpo próprio encolhem na mesma proporção (no DOM eles são `em`).
        e = { ...e, size: fitted, fitScale: fitted / (Number(e.size) || fitted) };
      } finally {
        measure.remove();
      }
    }
    // Baseline como no CSS (editorTextHtml): meia-entrelinha em volta da área de conteúdo
    // ascent+descent da fonte, não do em-box — senão o PNG/PDF exportado desloca o texto em
    // relação ao que o editor mostra (e ao PDF importado, medido nesse mesmo modelo).
    if (e.caps) e = { ...e, text: String(e.text ?? "").toUpperCase(), runs: e.runs?.map((r: any) => ({ ...r, text: r.text.toUpperCase() })) };
    x.textBaseline = "alphabetic";
    (x as any).letterSpacing = `${Number(e.ls) || 0}px`;
    if (e.textFx?.type === "bg") {
      // Fundo do texto: bloco arredondado atrás da caixa (no DOM é o fundo do próprio .txt).
      const n = Number(e.textFx.size) || 4;
      x.save(); x.fillStyle = e.textFx.color || "#ffe066"; x.beginPath();
      x.roundRect(-n * 1.4, -n, e.w + n * 2.8, e.h + n * 2, n); x.fill(); x.restore();
    }
    if (e.curve) { drawCurvedText(x, e); (x as any).letterSpacing = "0px"; return; }
    if (e.runs && e.runs.length) { drawRichText(x, e); (x as any).letterSpacing = "0px"; return; }
    x.fillStyle = e.fill;
    x.font = `${e.italic ? "italic " : ""}${e.weight} ${e.size}px "${e.font}", Inter, system-ui, sans-serif`;
    const lh = e.size * e.lh;
    const lines: Array<{ text: string; last: boolean }> = [];
    for (const para of String(e.text).split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const t = line ? line + " " + word : word;
        if (x.measureText(t).width > e.w && line) { lines.push({ text: line, last: false }); line = word; }
        else line = t;
      }
      lines.push({ text: line, last: true });
    }
    lines.forEach(({ text: ln, last }, i) => {
      const w = x.measureText(ln).width;
      const tx = e.align === "center" ? (e.w - w) / 2 : e.align === "right" ? e.w - w : 0;
      const ty = cssBaseline(x, i, lh);
      const words = ln.split(" ");
      if (e.align === "justify" && !last && words.length > 1) {
        // Justificado como no CSS: a sobra da linha vai para os espaços; a última linha do
        // parágrafo fica alinhada à esquerda.
        const gap = (e.w - words.reduce((s, wd) => s + x.measureText(wd).width, 0)) / (words.length - 1);
        let cx = 0;
        for (const wd of words) { paintText(x, e, wd, cx, ty, e.fill); cx += x.measureText(wd).width + gap; }
      } else paintText(x, e, ln, tx, ty, e.fill);
      const lw = e.align === "justify" && !last && words.length > 1 ? e.w : w;
      const lx = e.align === "justify" && !last ? 0 : tx;
      if (e.underline) { x.fillRect(lx, ty + e.size * 0.12, lw, Math.max(1, e.size / 16)); }
      if (e.strike) { x.fillRect(lx, ty - e.size * 0.3, lw, Math.max(1, e.size / 16)); }
    });
    (x as any).letterSpacing = "0px";
  }
}

/** As páginas dadas, renderizadas e empurradas numa página HTML estática só — usado pela
 *  exportação em HTML do design e de uma versão do histórico. */
async function buildScreensHtml(pages: Page[], title: string, scale: number, onPage?: (done: number) => void): Promise<string> {
  const imgs = [];
  for (const p of pages) {
    onPage?.(imgs.length);
    const c = await renderPageCanvas(p, scale);
    imgs.push(`<img src="${c.toDataURL("image/png")}" width="${p.w}" height="${p.h}" style="display:block;max-width:100%;height:auto;margin:0 auto 24px;box-shadow:0 1px 8px rgba(0,0,0,.15)">`);
  }
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f2f2f2">${imgs.join("")}</body></html>\n`;
}

/** Mesma checagem em dois pontos de saída (exportar o design, exportar uma versão): um design gerado
 *  só sai da máquina depois de aprovado. Devolve `false` (e já mostra o toast/fecha o modal)
 *  quando algo bloqueia; quem chama só precisa checar o retorno antes de seguir. */
async function ensureCanDownload(): Promise<boolean> {
  if (!looksGenerated(doc.seedId) || legacyGeneratedDesign) return true;
  // A pessoa pode clicar antes do autosave disparar. Salvar e reler o estado aqui fecha essa
  // janela: uma edição feita depois da aprovação volta a rascunho antes de qualquer byte sair.
  clearTimeout(persistTimer);
  if (!await syncTemplateToServer(doc)) {
    $("scrim").hidden = true;
    toast("Não foi possível confirmar a versão atual antes do download.");
    return false;
  }
  await refreshGenerationReview();
  if (!generationReview?.canDownload) {
    $("scrim").hidden = true;
    toast("A versão precisa ser aprovada antes do download.");
    return false;
  }
  return true;
}

async function doExport() {
  if (expBusy || !await ensureCanDownload()) return;
  const name = (doc.name || "design").replace(/[^\w \-]/g, "").trim() || "design";
  const saver = downloads ?? { save: browserDownload };
  const pages = exportPages();
  const progress = (done: number) => {
    if (pages.length > 1) $("expGo").textContent = `Gerando ${Math.min(done + 1, pages.length)}/${pages.length}…`;
  };
  let saving = expFmt;
  setExportBusy(true, "Gerando…");
  try {
    await document.fonts.ready;
    if (expFmt === "json") {
      await saver.save({ filename: `${name}.json`, data: JSON.stringify(doc, null, 2) });
      toast("Salvo"); return;
    }
    if (expFmt === "pdf") {
      const pgs = [];
      for (const p of pages) {
        progress(pgs.length);
        const c = await renderPageCanvas(p, expScale);
        const b64 = c.toDataURL("image/jpeg", 0.92).split(",")[1];
        pgs.push({ bytes: b64ToBytes(b64), pw: c.width, ph: c.height, w: p.w, h: p.h });
      }
      $("expGo").textContent = "Salvando…";
      await saver.save({ filename: `${name}.pdf`, data: buildPDF(pgs) });
      toast(pages.length > 1 ? `PDF com ${pages.length} páginas salvo` : "Salvo"); return;
    }
    if (expFmt === "html") {
      // Uma página HTML estática com as telas empilhadas — pra abrir/compartilhar sem
      // precisar do editor nem de um PDF, um arquivo só por design em vez de um por página.
      const html = await buildScreensHtml(pages, name, expScale, progress);
      $("expGo").textContent = "Salvando…";
      await saver.save({ filename: `${name}.html`, data: html });
      toast("Salvo"); return;
    }
    const mime = expFmt === "jpg" ? "image/jpeg" : "image/png";
    const renderBlob = async (p: Page) => {
      const c = await renderPageCanvas(p, expScale, { transparent: expTransparent && expFmt === "png" });
      return new Promise<Blob>((res, rej) => c.toBlob((b) => b ? res(b) : rej(new Error("canvas vazio")), mime, 0.94));
    };
    if (pages.length === 1) {
      const p = pages[0];
      const blob = await renderBlob(p);
      await saver.save({ filename: `${name}-page-${doc.pages.indexOf(p) + 1}.${expFmt}`, data: blob });
      toast("Salvo"); return;
    }
    // Várias imagens → um .zip só (como o Canva). Numeração sequencial na ordem exportada,
    // pra que 01…N seja a ordem de postagem mesmo com páginas ocultas no meio.
    const pad = Math.max(2, String(pages.length).length);
    const entries = [];
    for (const p of pages) {
      progress(entries.length);
      const blob = await renderBlob(p);
      entries.push({ name: `${name}-${String(entries.length + 1).padStart(pad, "0")}.${expFmt}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    saving = "zip";
    $("expGo").textContent = "Compactando…";
    await saver.save({ filename: `${name}.zip`, data: buildZip(entries) });
    toast(`${pages.length} páginas salvas em ${name}.zip`);
  } catch (err) {
    const code = err?.code;
    if (code === "declined") return;
    if (code === "extension_not_enabled") {
      toast(saving === "zip" ? "ZIP não está habilitado aqui — exporte só a página atual ou em PDF."
        : `${saving.toUpperCase()} não está habilitado aqui — use PNG ou JPG.`);
      return;
    }
    if (code === "too_large") { toast("Muito grande — tente uma escala menor."); return; }
    if (code === "rate_limited") { toast("Um download por vez — tente de novo em instantes."); return; }
    toast("Falha ao exportar: " + (err?.message || code || "desconhecido"));
  } finally {
    setExportBusy(false);
    closeExport();
  }
}

/* file menu */
function closeFileMenu() {
  $("fileMenu").hidden = true;
  $("fileMenuBtn").setAttribute("aria-expanded", "false");
}
function renderFileMenu() {
  const canManage = !!doc.seedId;
  const item = (action: string, label: string, danger = false) => `
    <button data-fmaction="${action}" class="${danger ? "danger" : ""}">${label}</button>`;
  $("fileMenu").innerHTML = [
    item("rename", "Renomear"),
    item("resize", "Redimensionar páginas"),
    canManage ? item("duplicate", "Duplicar") : "",
    canManage ? item("share", "Compartilhar") : "",
    canManage ? item("history", "Histórico de versões") : "",
    canManage ? item("comments", "Comentários") : "",
    item("brand", "Marca"),
    canManage ? item("copy-id", "Copiar ID") : "",
    item("open-json", "Abrir arquivo local…"),
    canManage ? `<div class="dropsep"></div>${item("delete", "Excluir", true)}` : "",
  ].join("");
}
$("fileMenuBtn").addEventListener("click", () => {
  const open = !$("fileMenu").hidden;
  if (open) { closeFileMenu(); return; }
  renderFileMenu();
  $("fileMenu").hidden = false;
  $("fileMenuBtn").setAttribute("aria-expanded", "true");
});
$("fileMenu").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-fmaction]");
  if (!b) return;
  const action = b.dataset.fmaction;
  closeFileMenu();
  if (action === "rename") { $("docname").focus(); $("docname").select(); return; }
  if (action === "resize") { setPanel("page"); return; }
  if (action === "open-json") { $("fileJson").click(); return; }
  if (action === "copy-id") {
    navigator.clipboard?.writeText(doc.seedId || "").then(() => toast("ID copiado")).catch(() => {});
    return;
  }
  if (action === "duplicate") {
    try {
      const id = await createTemplateOnServer(`${doc.name} (cópia)`, doc);
      toast("Template duplicado");
      openTemplateById(id);
    } catch { toast("Não foi possível duplicar."); }
    return;
  }
  if (action === "history") { openHistory(); return; }
  if (action === "share") { openShare(); return; }
  if (action === "comments") { openComments(); return; }
  if (action === "brand") { openBrandKits(); return; }
  if (action === "delete") {
    $("confirmMsg").textContent = `Excluir o template "${doc.name}"? Isso não pode ser desfeito.`;
    $("confirmScrim").hidden = false;
    return;
  }
});
$("resizeBtn").addEventListener("click", () => setPanel("page"));
window.addEventListener("pointerdown", (ev) => {
  const t = ev.target as HTMLElement | null;
  if (t && !t.closest("#fileMenu") && !t.closest("#fileMenuBtn")) closeFileMenu();
}, true);

$("confirmCancel").addEventListener("click", () => { $("confirmScrim").hidden = true; });
$("confirmScrim").addEventListener("click", (e) => { if (e.target === $("confirmScrim")) $("confirmScrim").hidden = true; });
$("confirmGo").addEventListener("click", async () => {
  $("confirmScrim").hidden = true;
  const id = doc.seedId;
  if (!id) return;
  try {
    await deleteTemplateOnServer(id);
    forgetDeletedDesign(id);
    toast("Template excluído");
    location.hash = "/console/templates";
  } catch { toast("Não foi possível excluir."); }
});

/* compartilhar (item 3.2 + 4.2 do backlog) */
function renderShareModal(status: ShareStatus) {
  $("shareOff").setAttribute("aria-pressed", String(status.visibility === "private"));
  $("shareOn").setAttribute("aria-pressed", String(status.visibility === "link"));
  $("shareLinkRow").hidden = status.visibility !== "link" || !status.publicUrl;
  if (status.publicUrl) ($("shareLinkInput") as HTMLInputElement).value = location.origin + status.publicUrl;
}

async function openShare() {
  if (!doc.seedId) return;
  $("shareScrim").hidden = false;
  try {
    renderShareModal(await getShareStatus(doc.seedId));
  } catch { toast("Não foi possível carregar o status de compartilhamento."); }
}

async function toggleShare(visibility: "private" | "link") {
  if (!doc.seedId) return;
  try {
    renderShareModal(await setShareVisibility(doc.seedId, visibility));
    toast(visibility === "link" ? "Link público ativado" : "Voltou a ser privado");
  } catch { toast("Não foi possível atualizar o compartilhamento."); }
}

$("shareOff").addEventListener("click", () => toggleShare("private"));
$("shareOn").addEventListener("click", () => toggleShare("link"));
$("shareClose").addEventListener("click", () => { $("shareScrim").hidden = true; });
$("shareScrim").addEventListener("click", (e) => { if (e.target === $("shareScrim")) $("shareScrim").hidden = true; });
$("shareCopyLink").addEventListener("click", () => {
  const input = $("shareLinkInput") as HTMLInputElement;
  navigator.clipboard?.writeText(input.value).then(() => toast("Link copiado")).catch(() => {
    input.select();
    toast("Selecionado — copie com ⌘C");
  });
});

/* histórico de versão (item 4.1 do backlog) */
let historyVersions: DesignVersionSummary[] = [];

async function refreshHistory() {
  if (!doc.seedId) return;
  try {
    historyVersions = await listDesignVersionsFromServer(doc.seedId);
  } catch {
    historyVersions = [];
    toast("Não foi possível carregar o histórico.");
  }
  renderHistoryList();
}

function renderHistoryList() {
  const el = $("historyList");
  if (!historyVersions.length) {
    el.innerHTML = `<p class="phint">Nenhuma versão salva ainda.</p>`;
    return;
  }
  el.innerHTML = historyVersions.map((v) => `
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">
      <div>
        <strong style="display:block;font-size:13px">${esc(v.name)}</strong>
        <span class="phint">${relativeTime(v.createdAt)}</span>
      </div>
      <div class="row" style="gap:6px">
        <button class="tbtn ghost" data-hist-action="export" data-hist-id="${v.id}" title="Baixa esta versão como HTML, sem alterar o design atual">Exportar</button>
        <button class="tbtn ghost" data-hist-action="restore" data-hist-id="${v.id}" title="Substitui o design atual pelo conteúdo desta versão">Restaurar</button>
        <button class="tbtn ghost" data-hist-action="duplicate" data-hist-id="${v.id}" title="Cria um design novo e independente a partir desta versão">Duplicar</button>
        <button class="tbtn ghost danger" data-hist-action="delete" data-hist-id="${v.id}">Excluir</button>
      </div>
    </div>`).join("");
}

async function openHistory() {
  if (!doc.seedId) return;
  ($("historyNameInput") as HTMLInputElement).value = "";
  $("historyScrim").hidden = false;
  await refreshHistory();
}

$("historySave").addEventListener("click", async () => {
  if (!doc.seedId) return;
  const input = $("historyNameInput") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) { toast("Dê um nome pra versão."); return; }
  // Garante que o snapshot é o que está na tela AGORA, não a última cópia que o autosave já
  // tinha mandado — mesma preocupação de `ensureCanDownload` (item 3.1c), aplicada aqui a
  // "salvar versão" em vez de "exportar".
  if (!await syncTemplateToServer(doc)) { toast("Não foi possível salvar antes de criar a versão."); return; }
  try {
    await createDesignVersionOnServer(doc.seedId, name);
    input.value = "";
    toast("Versão salva");
    await refreshHistory();
  } catch { toast("Não foi possível salvar a versão."); }
});
$("historyClose").addEventListener("click", () => { $("historyScrim").hidden = true; });
$("historyScrim").addEventListener("click", (e) => { if (e.target === $("historyScrim")) $("historyScrim").hidden = true; });
$("historyList").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest("[data-hist-action]");
  if (!b || !doc.seedId) return;
  const templateId = doc.seedId;
  const versionId = b.getAttribute("data-hist-id")!;
  const action = b.getAttribute("data-hist-action");
  if (action === "export") {
    if (!await ensureCanDownload()) return;
    try {
      const version = await fetchDesignVersionDocument(templateId, versionId);
      const baseName = (doc.name || "design").replace(/[^\w \-]/g, "").trim() || "design";
      const versionName = version.name.replace(/[^\w \-]/g, "").trim() || "versao";
      await document.fonts.ready;
      const html = await buildScreensHtml(version.document.pages.filter((p) => !p.hidden), `${baseName} - ${versionName}`, expScale);
      const saver = downloads ?? { save: browserDownload };
      await saver.save({ filename: `${baseName} - ${versionName}.html`, data: html });
      toast("Salvo");
    } catch { toast("Não foi possível exportar esta versão."); }
  }
  if (action === "restore") {
    try {
      await restoreDesignVersionOnServer(templateId, versionId);
      $("historyScrim").hidden = true;
      toast("Versão restaurada");
      await openTemplateById(templateId);
    } catch { toast("Não foi possível restaurar."); }
  }
  if (action === "duplicate") {
    try {
      const newId = await duplicateDesignVersionOnServer(templateId, versionId);
      $("historyScrim").hidden = true;
      toast("Versão duplicada como um novo design");
      openTemplateById(newId);
    } catch { toast("Não foi possível duplicar."); }
  }
  if (action === "delete") {
    try {
      await deleteDesignVersionOnServer(templateId, versionId);
      await refreshHistory();
    } catch { toast("Não foi possível excluir."); }
  }
});

/* comentários fixados no canvas (item 4.3 do backlog) */
async function refreshComments() {
  if (!doc.seedId) return;
  try {
    commentsData = await listCommentsFromServer(doc.seedId);
  } catch {
    commentsData = [];
    toast("Não foi possível carregar os comentários.");
  }
  renderCommentList();
  renderCanvas(); // reflete pins novos/removidos/resolvidos no canvas
}

function renderCommentList() {
  const el = $("commentList");
  if (!commentsData.length) {
    el.innerHTML = `<p class="phint">Nenhum comentário ainda.</p>`;
    return;
  }
  el.innerHTML = commentsData.map((c) => `
    <div class="row" style="flex-direction:column;align-items:stretch;gap:6px;padding:8px 0;border-bottom:1px solid var(--line)">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
        <div>
          <strong style="display:block;font-size:13px">Página ${c.pageIndex + 1}${c.resolved ? " · resolvido" : ""}</strong>
          <span style="font-size:13px">${esc(c.body)}</span>
          <span class="phint" style="display:block">${relativeTime(c.createdAt)}</span>
        </div>
        <div class="row" style="gap:6px">
          <button class="tbtn ghost" data-comment-action="${c.resolved ? "reopen" : "resolve"}" data-comment-id="${c.id}">${c.resolved ? "Reabrir" : "Resolver"}</button>
          <button class="tbtn ghost danger" data-comment-action="delete" data-comment-id="${c.id}">Excluir</button>
        </div>
      </div>
      ${c.replies.map((r) => `<div class="phint" style="padding-left:12px">↳ ${esc(r.body)}</div>`).join("")}
      <div class="row" style="gap:6px">
        <input class="commentReplyInput" data-comment-id="${c.id}" placeholder="Responder…" style="flex:1">
        <button class="tbtn ghost" data-comment-action="reply" data-comment-id="${c.id}">Enviar</button>
      </div>
    </div>`).join("");
}

async function openComments() {
  if (!doc.seedId) return;
  $("commentScrim").hidden = false;
  await refreshComments();
}

let pendingCommentSpot: { pageIdx: number; x: number; y: number } | null = null;

/** Chamado pelo clique-pra-fixar no canvas (ver o handler de pointerdown do #stage) — abre o
 *  compose já sabendo onde o pino vai, sem precisar reabrir o painel primeiro. */
function openCommentCompose(pageIdx: number, x: number, y: number) {
  pendingCommentSpot = { pageIdx, x, y };
  ($("commentComposeInput") as HTMLTextAreaElement).value = "";
  $("commentComposeScrim").hidden = false;
  ($("commentComposeInput") as HTMLTextAreaElement).focus();
}

$("commentAdd").addEventListener("click", () => {
  placingComment = true;
  $("commentScrim").hidden = true;
  $("stage").style.cursor = "crosshair";
  toast("Clique no canvas pra fixar o comentário");
});
$("commentClose").addEventListener("click", () => { $("commentScrim").hidden = true; });
$("commentScrim").addEventListener("click", (e) => { if (e.target === $("commentScrim")) $("commentScrim").hidden = true; });
$("commentList").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest("[data-comment-action]");
  if (!b || !doc.seedId) return;
  const templateId = doc.seedId;
  const commentId = b.getAttribute("data-comment-id")!;
  const action = b.getAttribute("data-comment-action");
  if (action === "resolve" || action === "reopen") {
    try {
      await setCommentResolvedOnServer(templateId, commentId, action === "resolve");
      await refreshComments();
    } catch { toast("Não foi possível atualizar o comentário."); }
  }
  if (action === "delete") {
    try {
      await deleteCommentOnServer(templateId, commentId);
      await refreshComments();
    } catch { toast("Não foi possível excluir."); }
  }
  if (action === "reply") {
    const input = ($("commentList") as HTMLElement).querySelector<HTMLInputElement>(`.commentReplyInput[data-comment-id="${commentId}"]`);
    const body = input?.value.trim();
    if (!body) return;
    try {
      await replyToCommentOnServer(templateId, commentId, body);
      await refreshComments();
    } catch { toast("Não foi possível responder."); }
  }
});
$("commentComposeCancel").addEventListener("click", () => { $("commentComposeScrim").hidden = true; pendingCommentSpot = null; });
$("commentComposeScrim").addEventListener("click", (e) => { if (e.target === $("commentComposeScrim")) { $("commentComposeScrim").hidden = true; pendingCommentSpot = null; } });
$("commentComposeSave").addEventListener("click", async () => {
  if (!doc.seedId || !pendingCommentSpot) return;
  const body = ($("commentComposeInput") as HTMLTextAreaElement).value.trim();
  if (!body) { toast("Escreva o comentário antes de salvar."); return; }
  const { pageIdx, x, y } = pendingCommentSpot;
  try {
    await createCommentOnServer(doc.seedId, { pageIndex: pageIdx, x, y, body });
    $("commentComposeScrim").hidden = true;
    pendingCommentSpot = null;
    toast("Comentário fixado");
    await refreshComments();
  } catch { toast("Não foi possível salvar o comentário."); }
});

/* painel de design system/marca (item 4.7 do backlog) */
async function refreshBrandKits() {
  try {
    brandKits = await listBrandKitsFromServer();
  } catch {
    brandKits = [];
    toast("Não foi possível carregar as paletas.");
  }
  renderBrandKitList();
}

function renderBrandKitList() {
  const el = $("brandList");
  if (!brandKits.length) {
    el.innerHTML = `<p class="phint">Nenhuma paleta salva ainda.</p>`;
    return;
  }
  el.innerHTML = brandKits.map((k) => `
    <div class="row" style="flex-direction:column;align-items:stretch;gap:6px;padding:8px 0;border-bottom:1px solid var(--line)">
      <div class="row" style="justify-content:space-between;align-items:center">
        <strong style="font-size:13px">${esc(k.name)}</strong>
        <button class="tbtn ghost danger" data-brand-action="delete" data-brand-id="${k.id}">Excluir</button>
      </div>
      ${k.colors.length ? `<div class="row" style="gap:6px;flex-wrap:wrap">
        ${k.colors.map((c) => `<button class="swatch" data-brand-action="apply-color" data-brand-color="${esc(c)}" title="Aplicar ${esc(c)} ao preenchimento" style="background:${esc(c)};width:32px"></button>`).join("")}
      </div>` : ""}
      ${k.fonts.length ? `<div class="row" style="gap:6px;flex-wrap:wrap">
        ${k.fonts.map((f) => `<button class="tbtn ghost" data-brand-action="apply-font" data-brand-font="${esc(f)}" style="font-family:'${esc(f).replace(/"/g, "")}'">${esc(f)}</button>`).join("")}
      </div>` : ""}
    </div>`).join("");
}

function openBrandKits() {
  $("brandScrim").hidden = false;
  void refreshBrandKits();
}

/** Cores e fontes efetivamente em uso no design atual — a fonte da paleta "salvar atual", sem
 *  precisar de uma UI de seleção manual (o design já É a curadoria). */
function distinctDocColorsAndFonts(): { colors: string[]; fonts: string[] } {
  const colors = new Set<string>();
  const fonts = new Set<string>();
  for (const p of doc.pages) {
    for (const e of p.els) {
      if (typeof e.fill === "string" && /^#[0-9a-f]{6}$/i.test(e.fill)) colors.add(e.fill.toLowerCase());
      if (e.type === "text" && typeof e.font === "string" && e.font) fonts.add(e.font);
    }
  }
  return { colors: [...colors], fonts: [...fonts] };
}

$("brandSave").addEventListener("click", async () => {
  const input = $("brandNameInput") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) { toast("Dê um nome pra paleta."); return; }
  const { colors, fonts } = distinctDocColorsAndFonts();
  if (!colors.length && !fonts.length) { toast("Este design não tem cores nem fontes pra salvar."); return; }
  try {
    await createBrandKitOnServer(name, colors, fonts);
    input.value = "";
    toast("Paleta salva");
    await refreshBrandKits();
  } catch { toast("Não foi possível salvar a paleta."); }
});
$("brandClose").addEventListener("click", () => { $("brandScrim").hidden = true; });
$("brandScrim").addEventListener("click", (e) => { if (e.target === $("brandScrim")) $("brandScrim").hidden = true; });
$("brandList").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest("[data-brand-action]");
  if (!b) return;
  const action = b.getAttribute("data-brand-action");
  if (action === "delete") {
    const id = b.getAttribute("data-brand-id")!;
    try { await deleteBrandKitOnServer(id); await refreshBrandKits(); }
    catch { toast("Não foi possível excluir."); }
    return;
  }
  if (!sel.length) { toast("Selecione um elemento primeiro."); return; }
  if (action === "apply-color") {
    patch({ fill: b.getAttribute("data-brand-color")! }, true);
    toast("Cor aplicada");
  }
  if (action === "apply-font") {
    patch({ font: b.getAttribute("data-brand-font")! }, true);
    toast("Fonte aplicada");
  }
});

/* import / upload */
$("fileJson").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    if (!o.pages?.length) throw new Error("no pages");
    doc = normalizeDoc(o); doc.active = clamp(doc.active | 0, 0, doc.pages.length - 1); sel = [];
    $("docname").value = doc.name || "Untitled design";
    commit(); renderAll(); zoomFit(); toast("Design aberto");
  } catch (e) { toast("Esse arquivo não é um design criado por este editor."); }
  ev.target.value = "";
});
$("fileFont").addEventListener("cancel", () => { missingFontTarget = null; weightsTarget = null; });
$("fileFont").addEventListener("change", async (ev) => {
  // Vários arquivos de uma vez: a família inteira (Regular, Bold, Italic…) num envio só.
  const files = [...ev.target.files] as File[];
  ev.target.value = "";
  const pedida = missingFontTarget;
  const familia = weightsTarget;
  missingFontTarget = null; weightsTarget = null;
  for (const file of files) {
    if (!/\.(ttf|otf)$/i.test(file.name)) { toast(`${file.name}: envie um arquivo .ttf ou .otf.`); continue; }
    if (file.size > 20_000_000) { toast(`${file.name} é grande demais (máximo 20 MB).`); continue; }
    await importarFonte(file, pedida, familia);
  }
  renderMissingFonts();
});
$("fileImg").addEventListener("change", async (ev) => {
  const files = [...ev.target.files];
  for (const f of files) {
    if (f.size > 4_000_000) { toast(`${f.name} passa de 4 MB — ignorado.`); continue; }
    const src = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(f); });
    const img = await loadImg(src).catch(() => null);
    if (!img) { toast(`Não foi possível ler ${f.name}.`); continue; }
    const p = page();
    const s = Math.min(1, (p.w * 0.6) / img.width, (p.h * 0.6) / img.height);
    addEl("image", { src, w: Math.round(img.width * s), h: Math.round(img.height * s), name: f.name.slice(0, 28) });
  }
  ev.target.value = "";
});



/* ============================ keyboard ============================ */
function setTool(t) {
  tool = t;
  $("stage").style.cursor = t === "hand" ? "grab" : t === "draw" ? "crosshair" : "default";
  if (activeTab === "draw") renderPanel();
  $("selectTool").setAttribute("aria-pressed", String(t === "select"));
  $("handTool").setAttribute("aria-pressed", String(t === "hand"));
}
$("selectTool").onclick = () => setTool("select");
$("handTool").onclick = () => setTool("hand");
$("zoomSlider").addEventListener("input", (ev) => {
  const r = $("stage").getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, Number(ev.target.value) / 100);
});
const zoomCenter = (nz: number) => { const r = $("stage").getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, nz); };
/** Preencher: a página ocupa a largura (ou altura) inteira do canvas, sem margem. */
function zoomFill() {
  const s = $("stage").getBoundingClientRect(); const p = page();
  if (!s.width || !s.height) return;
  zoomCenter(Math.max(s.width / p.w, s.height / p.h));
  scrollToPage(doc.active); applyWorld(); renderOverlay();
}
function setZoomMenu(open: boolean) {
  const m = $("zoomMenu"), b = $("zoomval");
  m.hidden = !open; b.setAttribute("aria-expanded", String(open));
  if (!open) return;
  // A bottombar rola no eixo x, então o menu é fixo na viewport e abre para cima.
  const r = b.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left + r.width / 2 - m.offsetWidth / 2)) + "px";
  m.style.top = Math.max(8, r.top - m.offsetHeight - 6) + "px";
}
$("zoomval").onclick = () => setZoomMenu($("zoomMenu").hidden);
$("zoomMenu").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-zoom]"); if (!b) return;
  const z = b.dataset.zoom!;
  if (z === "fit") zoomFit(); else if (z === "fill") zoomFill(); else zoomCenter(+z);
  setZoomMenu(false);
});
window.addEventListener("pointerdown", (ev) => {
  if (!$("zoomMenu").hidden && !(ev.target as HTMLElement).closest("#zoomMenu, #zoomval")) setZoomMenu(false);
}, true);
$("docname").addEventListener("input", (e) => {
  doc.name = e.target.value;
  // A aba guarda o nome que tinha quando o design foi aberto. Sem isto, renomear deixava a
  // aba com o nome velho ate a proxima recarga — e a lista de abas e como a pessoa reconhece
  // qual design e qual.
  renameRecentDesign(doc.seedId, doc.name);
  persist();
});
$("docname").addEventListener("change", commit);
$("undoBtn").addEventListener("click", undo);
$("redoBtn").addEventListener("click", redo);

const typing = () => {
  const a = document.activeElement;
  const el = a as HTMLElement | null;
  // TEXTAREA precisa estar aqui junto com INPUT: sem ele, todo atalho abaixo é
  // preventDefault'ado dentro de uma caixa de texto multilinha — o composer de comentário
  // e o Playground perdiam Ctrl+C/V/Z/A, e Backspace nem apagava caractere.
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * O editor está na tela?
 *
 * Este módulo registra o listener de teclado no `window` no momento do import, e o import
 * acontece no boot do app (main.tsx) — não quando o editor abre. O router só alterna
 * `display` entre as views; nada desmonta. Sem esta checagem, os atalhos do editor valiam
 * no site inteiro: na tela de login e no console, Ctrl+C/V/Z/A eram capturados e
 * preventDefault'ados por um editor que nem estava visível, então copiar texto da página
 * simplesmente não funcionava — o navegador nunca chegava a emitir o evento `copy`.
 *
 * A checagem é sobre `display` porque é exatamente o que o router manipula (router.ts).
 */
function editorAtivo(): boolean {
  const view = document.getElementById("view-editor");
  return !!view && view.style.display !== "none";
}

window.addEventListener("keydown", (e) => {
  if (!editorAtivo()) return;
  if (e.key === "Escape" && !$("present").hidden) { exitPresent(); return; }
  if (e.key === "Escape" && !$("gridview").hidden) { setPagesMode("document"); return; }
  if (e.code === "Space" && !typing() && !(document.activeElement instanceof HTMLButtonElement)) { e.preventDefault(); spaceDown = true; $("stage").style.cursor = "grab"; }
  if (typing()) { if (e.key === "Escape") (document.activeElement as HTMLElement).blur(); return; }
  // Let focused controls keep native keyboard activation and scrolling.
  if (document.activeElement instanceof HTMLButtonElement && (e.key === "Enter" || e.code === "Space")) return;
  if (document.activeElement?.id === "documentScroll" && ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  // Só sequestra Ctrl+C/V quando há de fato o que copiar ou colar no canvas. Sem seleção, o
  // atalho tem que chegar ao navegador: dentro do editor também se copia texto de um painel,
  // e antes isso era engolido em silêncio (copySel() sem seleção não fazia nada — nem toast).
  // Alt+Ctrl+C / Alt+Ctrl+V: copiar e colar estilo (atalho do Canva). `e.code` porque Alt no
  // Mac troca a letra de `e.key` ("ç", "√").
  if (mod && e.altKey && e.code === "KeyC") { e.preventDefault(); if (sel.length) { armCopyStyle(); } return; }
  if (mod && e.altKey && e.code === "KeyV") { e.preventDefault(); pasteCopiedStyleOnSelection(); return; }
  if (e.key === "Escape" && copiedStyle) { copiedStyle = null; document.body.classList.remove("painting"); renderToolbar(); return; }
  if (mod && k === "c") { if (!sel.length) return; e.preventDefault(); copySel(); return; }
  if (mod && k === "v") { if (!clipboard?.length) return; e.preventDefault(); paste(); return; }
  if (mod && k === "d") { e.preventDefault(); duplicateSel(); return; }
  if (mod && k === "g") { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return; }
  if (mod && k === "a") { e.preventDefault(); sel = page().els.filter((x) => !x.hidden).map((x) => x.id); renderAll(); return; }
  if (mod && (k === "=" || k === "+")) { e.preventDefault(); zoomCenter(zoom * 1.2); return; }
  if (mod && k === "-") { e.preventDefault(); zoomCenter(zoom / 1.2); return; }
  if (mod && k === "0") { e.preventDefault(); zoomFit(); return; }
  if (mod && k === "1") { e.preventDefault(); const r = $("stage").getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1); return; }
  if (mod && e.key === "]") { e.preventDefault(); order("up"); return; }
  if (mod && e.key === "[") { e.preventDefault(); order("down"); return; }
  if (e.key === "Delete" || e.key === "Backspace") { if (sel.length) { e.preventDefault(); deleteSel(); } return; }
  if (e.key === "Escape") { sel = []; editingId = null; propPopOpen = false; closeFileMenu(); setTool("select"); renderAll(); return; }
  if (e.key === "Enter" && sel.length === 1) { e.preventDefault(); startEditingText(sel[0]); return; }
  if (e.key.startsWith("Arrow") && sel.length) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
    const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
    for (const el of selEls()) if (!el.locked) { el.x += dx; el.y += dy; }
    renderCanvas(); renderProps(); clearTimeout(window.__nudge);
    window.__nudge = setTimeout(commit, 350);
    return;
  }
  if (!mod) {
    if (k === "v") setTool("select");
    if (k === "h") setTool("hand");
    if (k === "p") setTool("draw");
    if (k === "t") addEl("text");
    if (k === "r") addEl("rect");
    if (k === "o") addEl("ellipse");
    if (k === "l") addEl("line");
  }
});
window.addEventListener("keyup", (e) => {
  if (!editorAtivo()) return;
  if (e.code === "Space") { spaceDown = false; $("stage").style.cursor = tool === "hand" ? "grab" : tool === "draw" ? "crosshair" : "default"; }
});

let toastTimer;
type ToastOpts = { kind?: "ok" | "error" | "info"; action?: { label: string; fn: () => void } };
const TOAST_ICON = {
  ok: `<path d="M21.8 10A10 10 0 1 1 17 3.3"/><path d="m9 11 3 3L22 4"/>`,
  error: `<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>`,
};
/** Sem `kind`, adivinha pelo texto: mensagens de falha ganham o ícone de alerta. */
function toast(msg: string, opts: ToastOpts = {}) {
  const t = $("toast");
  const kind = opts.kind ?? (/^(não|falha|erro|muito grande|um download)/i.test(msg) ? "error" : "info");
  const icon = kind === "info" ? "" : `<svg class="toasticon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOAST_ICON[kind]}</svg>`;
  t.innerHTML = `${icon}<span>${esc(msg)}</span>${opts.action ? `<button class="toastaction" type="button">${esc(opts.action.label)}</button>` : ""}`;
  t.dataset.kind = kind;
  t.hidden = false;
  const act = t.querySelector(".toastaction") as HTMLButtonElement | null;
  if (act && opts.action) { const fn = opts.action.fn; act.onclick = () => { t.hidden = true; fn(); }; }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}



/* ============================ boot ============================ */
function renderAll() {
  renderCanvas(); renderProps(); renderLayers(); renderMissingFonts();
}

/* ------------------------- fontes do PDF faltando ------------------------- */
/** Designs em que a pessoa clicou "Depois" — o aviso vira um chip até ela reabrir. */
const missingFontsLater = new Set<string>();
let missingFontTarget: string | null = null;
/** Família que o envio atual vai completar (aviso "falta um arquivo da fonte"). */
let weightsTarget: string | null = null;
let missingFontsLibraryChecked = "";

/** Cartão do aviso de fonte (layout escolhido com o Jev: cartão no canto inferior direito, com
 *  ícone, título, uma linha de explicação, nome da fonte em destaque, botão principal largo,
 *  "Agora não" e X). "Agora não"/X viram um chip no mesmo canto que reabre o cartão. */
const FM_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 4-10 4 10"/><path d="M4.5 13h5"/><path d="M15 12.5a3 3 0 1 1 0 4.5"/><path d="M18 11v7"/></svg>`;
const FM_X = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
function fmCard(o: { title: string; text: string; chips: string[]; action: string; later: string }): string {
  return `<div class="fm-icon">${FM_ICON}</div>
    <div class="fm-body">
      <div class="fm-title">${o.title}</div>
      <div class="fm-sub">${o.text}</div>
      <div class="fm-chips">${o.chips.map((c) => `<span class="fm-font">${esc(c)}</span>`).join("")}</div>
      <div class="fm-actions">${o.action}<button class="fm-later" ${o.later}>Agora não</button></div>
    </div>
    <button class="fm-x" ${o.later} title="Fechar" aria-label="Fechar aviso">${FM_X}</button>`;
}
function fmChip(bar: HTMLElement, label: string, reopen: string) {
  bar.className = "fontMissing is-chip";
  bar.innerHTML = `<button class="fm-reopen" ${reopen}><span class="fm-dot"></span>${label}</button>`;
}

function renderMissingFonts() {
  const bar = $("fontMissing");
  const missing = missingPdfFonts(doc.pages);
  if (!missing.length) { renderMissingWeights(bar); return; }
  const docKey = doc.seedId || doc.name || "";
  // Uma consulta à biblioteca por design, em segundo plano: se alguém já subiu a fonte, o
  // botão vira "Aplicar" (um clique, sem arquivo). Nunca bloqueia o render.
  if (missingFontsLibraryChecked !== docKey) { missingFontsLibraryChecked = docKey; void refreshGlobalFonts().then(renderMissingFonts); }
  bar.hidden = false;
  if (missingFontsLater.has(docKey)) {
    fmChip(bar, missing.length === 1 ? "1 fonte para enviar" : `${missing.length} fontes para enviar`, "data-fm-reopen");
    return;
  }
  const m0 = missing[0];
  // "NewSpirit" (nome interno do PDF) -> "New Spirit", como a pessoa conhece a fonte.
  const m = { ...m0, family: m0.family.replace(/([a-z])([A-Z])/g, "$1 $2") };
  const inLibrary = globalFonts.some((f) => familyKey(f.family) === familyKey(m.family));
  const more = missing.length > 1 ? ` Depois dela, ${missing.length - 1 === 1 ? "falta mais 1 fonte" : `faltam mais ${missing.length - 1} fontes`}.` : "";
  bar.className = "fontMissing";
  bar.innerHTML = inLibrary
    ? fmCard({ title: "Essa fonte já está disponível", text: `Aplique para o texto ficar igual ao original.${more}`, chips: [m.family],
        action: `<button class="fm-add" data-fm-use="${esc(m.family)}">Aplicar fonte</button>`, later: "data-fm-later" })
    : fmCard({ title: "Fonte não disponível", text: `Usamos uma parecida por enquanto. Envie o arquivo da fonte para o texto ficar igual ao original.${more}`, chips: [m.family],
        action: `<button class="fm-add" data-fm-add="${esc(m.family)}">Enviar fonte</button>`, later: "data-fm-later" });
}

/** Segundo nível do aviso: a família já está no design, mas faltam estilos usados no texto
 *  (ex.: subiu o Bold, parte do texto usa Regular). Aceita vários arquivos de uma vez. */
function renderMissingWeights(bar: HTMLElement) {
  const docKey = doc.seedId || doc.name || "";
  const faltando = missingWeights(doc.pages, doc.fonts ?? []);
  if (!faltando.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const m = faltando[0];
  const nome = fontLabel(m.family).replace(/([a-z])([A-Z])/g, "$1 $2");
  const arquivos = m.missing.map((w) => `${nome} ${w}`);
  if (missingFontsLater.has(`${docKey}:pesos`)) {
    fmChip(bar, arquivos.length === 1 ? "1 arquivo de fonte para enviar" : `${arquivos.length} arquivos de fonte para enviar`, "data-fm-reopen-weights");
    return;
  }
  bar.className = "fontMissing";
  bar.innerHTML = fmCard({
    title: `Quase lá! Falta ${arquivos.length === 1 ? "um arquivo" : `${arquivos.length} arquivos`} da fonte`,
    text: `Parte do texto usa ${arquivos.length === 1 ? "este estilo" : "estes estilos"}. Envie o arquivo .ttf ou .otf — dá para selecionar vários de uma vez.`,
    chips: arquivos,
    action: `<button class="fm-add" data-fm-weights="${esc(m.family)}">Enviar arquivo${arquivos.length > 1 ? "s" : ""}</button>`,
    later: "data-fm-later-weights",
  });
}

function applyMissingFont(original: string, family: string) {
  const n = applyFontToOriginal(doc.pages, original, family);
  if (!n) return;
  commit();
  renderAll();
  toast(`${original}: ${n === 1 ? "1 texto atualizado" : `${n} textos atualizados`}.`);
}

$("fontMissing").addEventListener("click", async (ev) => {
  const t = ev.target as HTMLElement;
  const docKey = doc.seedId || doc.name || "";
  if (t.closest("[data-fm-later]")) { missingFontsLater.add(docKey); renderMissingFonts(); return; }
  if (t.closest("[data-fm-reopen]")) { missingFontsLater.delete(docKey); renderMissingFonts(); return; }
  if (t.closest("[data-fm-reopen-weights]")) { missingFontsLater.delete(`${docKey}:pesos`); renderMissingFonts(); return; }
  if (t.closest("[data-fm-later-weights]")) { missingFontsLater.add(`${docKey}:pesos`); renderMissingFonts(); return; }
  const wb = t.closest<HTMLElement>("[data-fm-weights]");
  if (wb) { missingFontTarget = null; weightsTarget = wb.dataset.fmWeights || null; if (!fontUploadBusy) $("fileFont").click(); return; }
  const add = t.closest<HTMLElement>("[data-fm-add]");
  if (add) { missingFontTarget = add.dataset.fmAdd!; if (!fontUploadBusy) $("fileFont").click(); return; }
  const use = t.closest<HTMLElement>("[data-fm-use]");
  if (use) {
    const original = use.dataset.fmUse!;
    const face = globalFonts.find((f) => familyKey(f.family) === familyKey(original));
    if (!face) return;
    const target = doc;
    const fonts = withGlobalFontFamily(target.fonts ?? [], globalFonts, face.family);
    try { await loadDesignFonts({ ...target, fonts }); } catch { toast("Não foi possível carregar essa fonte."); return; }
    if (doc !== target) return;
    doc.fonts = fonts;
    applyMissingFont(original, face.family);
  }
});

// The app now has three routes (login/console/editor) sharing one page, and
// this container starts hidden. Booting here — instead of at module-eval
// time — matters because zoomFit() reads the stage's bounding box: measured
// while display:none, that box is 0x0 and the initial zoom comes out wrong.
// mountEditor() runs once, the first time the router activates this route.
let editorMounted = false;
let pendingDocument = false;
// Setting location.hash below fires hashchange, which both the router and this module's own
// listener react to — that's the point (it's what makes the route actually switch), but it means
// a single click can end up calling openTemplateById for the same id two or three times over.
// Harmless (they'd all converge on the same result) but wasteful, so skip re-entry.
let loadingTemplateId: string | null = null;

/** Opens a template by id, preferring the server's copy over the local cache — the server is the source of truth once a template exists there. */
export async function openTemplateById(id: string) {
  if (loadingTemplateId === id) return;
  loadingTemplateId = id;
  designGone = false;
  // Encodes which template is open in the URL itself — without this, reloading (or opening a
  // shared link) has no way to know which document to restore and falls back to a blank one.
  // A real hash assignment (not history.replaceState) so the top-level router's hashchange
  // listener actually fires and switches the visible route — otherwise clicking a template from
  // the console silently updated the URL but left the console on screen until a manual reload.
  const target = `#/editor/${encodeURIComponent(id)}`;
  if (location.hash !== target) location.hash = target;
  try {
    await openTemplateDocument(await fetchTemplateFromServer(id));
    return;
  } catch { /* offline, or not created on the server yet — fall back to whatever's local */ }
  finally { if (loadingTemplateId === id) loadingTemplateId = null; }
  const local = loadTemplateLocally(id) ?? (id === TWEET_TEMPLATE_ID ? createTweetTemplateDocument() : null);
  if (local) await openTemplateDocument(local).catch(() => toast("Não foi possível carregar as fontes do design."));
  else toast("Não foi possível abrir esse template.");
}

export function openTweetTemplate() {
  return openTemplateById(TWEET_TEMPLATE_ID);
}

/** Opens any template document (by value) on the canvas — used for the seed template, an imported JSON file, or one fetched from the server by id. */
/** Fills in defaults for fields an older/handwritten/imported document might be missing —
 * otherwise a bare `NaN` (e.g. a missing `rot`) silently poisons any math done on it later. */
function normalizeDoc(d: Doc): Doc {
  for (const p of d.pages) {
    for (const e of p.els) {
      if (!Number.isFinite(e.rot)) e.rot = 0;
      if (!Number.isFinite(e.opacity)) e.opacity = 1;
      if (!Number.isFinite(e.w)) e.w = 20;
      if (!Number.isFinite(e.h)) e.h = 20;
    }
  }
  // Designs salvos antes de os nomes serem únicos continuam por aí, e é justamente neles que
  // o override da API escreve no elemento errado. Abrir e salvar conserta.
  dedupeLayerNames(d);
  return d;
}

let openingDocumentVersion = 0;
export async function openTemplateDocument(templateDoc: Doc) {
  const version = ++openingDocumentVersion;
  await loadDesignFonts(templateDoc);
  if (version !== openingDocumentVersion) return;
  doc = normalizeDoc(templateDoc);
  doc.active = clamp(doc.active | 0, 0, doc.pages.length - 1);
  pendingDocument = true;
  sel = [];
  past = [];
  future = [];
  baseline = snap();
  void refreshGenerationReview();
  commentsData = [];
  if (doc.seedId) pushRecentDesign(doc.seedId, doc.name);
  if (editorMounted) {
    $("docname").value = doc.name;
    renderAll();
    if (doc.seedId) void refreshComments();
    syncHistory();
    buildThumbs();
    requestAnimationFrame(zoomFit);
    renderRecentTabs();
  }
}

/* abas de designs abertos recentemente (item 4.5 do backlog) --------------
 * Preferência de sessão do navegador, não dado do design — por isso vive em
 * localStorage, não no banco. Escopo deliberadamente menor que "múltiplos
 * documentos abertos ao mesmo tempo": o editor tem UM `doc` global só, e dar
 * a cada aba seu próprio estado (undo, zoom, seleção) pediria reestruturar
 * isso — arriscado demais pra fazer sem poder testar ao vivo. O que existe
 * aqui é mais perto de "histórico recente" que vira atalho de navegação:
 * clicar noutra aba faz o mesmo que abrir aquele design pela lista de
 * designs, só que sem sair do editor. */
const RECENT_TABS_KEY = "blank-editor-recent-tabs";
const RECENT_TABS_MAX = 8;

interface RecentTab { id: string; name: string; }

function readRecentTabs(): RecentTab[] {
  try {
    const raw = localStorage.getItem(RECENT_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => t?.id && typeof t.name === "string") : [];
  } catch { return []; }
}

function writeRecentTabs(tabs: RecentTab[]) {
  try { localStorage.setItem(RECENT_TABS_KEY, JSON.stringify(tabs)); } catch { /* quota ou storage bloqueado */ }
}

/** Mantem o rotulo da aba igual ao nome do design, enquanto ele e digitado. */
function renameRecentDesign(id: string | undefined, name: string) {
  if (!id) return;
  const tabs = readRecentTabs();
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab.name === name) return;
  tab.name = name;
  writeRecentTabs(tabs);
  renderRecentTabs();
}

/** Tira da lista de abas um design que nao existe mais — chamado ao excluir e ao ver um 404. */
export function forgetRecentDesign(id: string) {
  writeRecentTabs(readRecentTabs().filter((t) => t.id !== id));
  renderRecentTabs();
}

function pushRecentDesign(id: string, name: string) {
  const tabs = readRecentTabs().filter((t) => t.id !== id);
  tabs.unshift({ id, name });
  writeRecentTabs(tabs.slice(0, RECENT_TABS_MAX));
}

function renderRecentTabs() {
  const el = $("recentTabs");
  const tabs = readRecentTabs();
  el.hidden = tabs.length < 2;
  if (tabs.length < 2) return;
  el.innerHTML = tabs.map((t) => `
    <button class="recentTab" data-recent-open="${t.id}" aria-current="${t.id === doc.seedId}" title="${esc(t.name)}">
      <span>${esc(t.name)}</span>
      <span class="recentTabClose" data-recent-close="${t.id}" title="Remover da lista (não apaga o design)" role="button">×</span>
    </button>`).join("");
}
$("recentTabs").addEventListener("click", (ev) => {
  const closeBtn = (ev.target as HTMLElement).closest<HTMLElement>("[data-recent-close]");
  if (closeBtn) {
    writeRecentTabs(readRecentTabs().filter((t) => t.id !== closeBtn.dataset.recentClose));
    renderRecentTabs();
    return;
  }
  const openBtn = (ev.target as HTMLElement).closest<HTMLElement>("[data-recent-open]");
  if (openBtn && openBtn.dataset.recentOpen !== doc.seedId) openTemplateById(openBtn.dataset.recentOpen!);
});

/** The document on the canvas right now, if it's a template (has a seedId) — null for the untitled/default design. */
export function currentTemplateDocument(): Doc | null {
  return doc.seedId ? structuredClone(doc) : null;
}

function templateIdFromHash(): string | null {
  const match = /^#\/editor\/([^/?]+)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Restores whichever template the URL names — the fix for "refresh loses the open template". */
function syncTemplateFromHash() {
  const id = templateIdFromHash();
  if (id && id !== doc.seedId) openTemplateById(id);
}

window.addEventListener("hashchange", syncTemplateFromHash);

export function mountEditor() {
  if (editorMounted) return;
  editorMounted = true;
  if (templateIdFromHash()) pendingDocument = true; // syncTemplateFromHash (below) is about to load it
  if (!pendingDocument) loadPersisted();
  syncTemplateFromHash();
  applyStageBg();
  baseline = snap();
  $("docname").value = doc.name || "Untitled design";
  renderRail(); renderPanel(); renderAll(); buildThumbs(); syncHistory(); renderRecentTabs();
  updatePagesModeButtons();
  requestAnimationFrame(zoomFit);
  document.fonts.ready.then(() => renderCanvas());
  // A panel or app split can resize the canvas without a window resize event.
  let stageWidth = $("stage").clientWidth;
  new ResizeObserver(() => {
    const stage = $("stage");
    if (!stage.clientWidth || !stage.clientHeight) return;
    const widthChanged = stageWidth !== stage.clientWidth;
    stageWidth = stage.clientWidth;
    if (fitView && widthChanged) zoomFit();
    else { clampView(); applyWorld(); renderOverlay(); }
  }).observe($("stage"));
}

// Automation handle. The fidelity suite renders pages through the real export
// path, so what it measures is exactly what a viewer downloads. It calls
// mountEditor() itself before reading pages(), same as the router does.
(window as any).blankEditor = {
  mount: mountEditor,
  renderPage: renderPageCanvas,
  pages: () => doc.pages,
  doc: () => doc,
  openTweetTemplate,
};
