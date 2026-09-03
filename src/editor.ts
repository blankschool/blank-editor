import "./styles.css";
import { loadDesignFonts } from "./designFontLoader";
import { b64ToBytes, buildPDF } from "./pdf";
import type { Doc, El, Page } from "./types";
import { createTweetTemplateDocument, TWEET_TEMPLATE_ID } from "./tweetTemplateDoc";
import { fetchTemplateFromServer, loadTemplateLocally, saveTemplateLocally, syncTemplateToServer, createTemplateOnServer, deleteTemplateOnServer } from "./templateStore";
import { pageOffset, pageAtY, zoomedPanY, verticalBounds } from "./editorViewport";
import { draggedLayerIds, reorderLayers, type LayerDropSide } from "./layerOrder";
import { attachLayerDrag } from "./layerDrag";
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

const FONTS = ["Inter", "Space Grotesk", "Montserrat", "Playfair Display", "Lora", "Oswald", "Bebas Neue", "DM Serif Display", "Caveat"];
const PAGE_SIZES = [
  { n: "Post", w: 1080, h: 1080 }, { n: "Post 4:5", w: 1080, h: 1350 }, { n: "Story", w: 1080, h: 1920 },
  { n: "Slide", w: 1920, h: 1080 }, { n: "A4", w: 794, h: 1123 },
  { n: "Capa", w: 1200, h: 630 }, { n: "Cartão", w: 1050, h: 600 },
];
const TYPE_PT = { rect: "Retângulo", ellipse: "Elipse", triangle: "Triângulo", star: "Estrela", line: "Linha", text: "Texto", image: "Imagem", icon: "Ícone", draw: "Desenho" };
const PT_ALIGN = { left: "à esquerda", center: "ao centro", cx: "ao centro", right: "à direita", top: "ao topo", cy: "ao meio", bottom: "à base" };
const PALETTE = ["#FFFFFF", "#F3F5F7", "#E3E8ED", "#CBD5DD", "#8296A1", "#4E636E", "#2A3A45", "#131C26"];
const STAGE_BG_PRESETS = ["#000000", "#181F25", "#2A3A45", "#4E636E", "#8296A1", "#CBD5DD", "#E3E8ED", "#F3F5F7"];

/* ============================ state ============================ */
const blankPage = () => ({ id: uid(), w: 1080, h: 1080, bg: "#000000", els: [] });
const SEED: Doc = { name: "Design sem título", pages: [blankPage()], active: 0 } as Doc;
let doc: Doc = SEED;
let sel: string[] = [];
let tool = "select";
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
let panelTab: "organize" | "layers" = "organize";
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
function persist() {
  clearTimeout(persistTimer);
  const seq = ++persistSeq;
  const st = document.getElementById("saveStatus");
  if (st) { st.textContent = "Salvando…"; st.dataset.state = "saving"; }
  persistTimer = setTimeout(async () => {
    try { localStorage.setItem(LS, JSON.stringify(doc)); } catch (e) { /* quota or blocked */ }
    saveTemplateLocally(doc);
    const synced = await syncTemplateToServer(doc);
    if (seq !== persistSeq) return;
    if (st) {
      st.textContent = synced ? "Salvo" : "Erro ao salvar";
      st.dataset.state = synced ? "saved" : "error";
    }
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
    id: uid(), type, name: TYPE_PT[type] || type,
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
function elInner(e: any) {
  const bd = e.stroke && e.strokeWidth ? `border:${e.strokeWidth}px solid ${e.stroke};` : "";
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
      return `<div style="width:100%;height:100%;background:${e.fill};border-radius:${e.h / 2}px"></div>`;
    case "image":
      return srcOf(e)
        ? `<img src="${srcOf(e)}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;border-radius:${e.radius}px;${bd}${sh}">`
        : `<div style="width:100%;height:100%;background:var(--surface-2)"></div>`;
    case "icon":
      return `<svg viewBox="${e.viewBox || "0 0 24 24"}" style="width:100%;height:100%;display:block"><path d="${e.path || ""}" fill="${e.fill}"/></svg>`;
    case "draw": {
      const d = (e.pts || []).map((p, i) => `${i ? "L" : "M"}${p[0] * e.w},${p[1] * e.h}`).join(" ");
      return `<svg viewBox="0 0 ${e.w} ${e.h}" style="width:100%;height:100%;overflow:visible"><path d="${d}" fill="none" stroke="${e.stroke}" stroke-width="${e.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    case "text": {
      const st = [
        `font-family:'${e.font}',Inter,system-ui,sans-serif`, `font-size:${e.size}px`,
        `font-weight:${e.weight}`, `font-style:${e.italic ? "italic" : "normal"}`,
        `text-decoration:${e.underline ? "underline" : "none"}`, `text-align:${e.align}`,
        `line-height:${e.lh}`, `letter-spacing:${e.ls}px`, `color:${e.fill}`,
      ].join(";");
      return `<div class="txt" data-txt="${e.id}" style="${st}">${esc(e.text)}</div>`;
    }
  }
  return "";
}

function pageHeaderHtml(i: number, p: Page): string {
  return `<div class="pagehead" data-pageidx="${i}">
    <span class="plabel2">Página ${i + 1}<small>${p.hidden ? " · oculta" : ` · ${p.w} × ${p.h}`}</small></span>
    <div class="pageminis">
      ${pageMini("moveuppage", PAGE_MINI.up, i, "Mover para cima", i === 0)}
      ${pageMini("movedownpage", PAGE_MINI.down, i, "Mover para baixo", i === doc.pages.length - 1)}
      ${pageMini("hidepage", p.hidden ? PAGE_MINI.hideOff : PAGE_MINI.hideOn, i, p.hidden ? "Mostrar página" : "Ocultar página")}
      ${pageMini("duppage", PAGE_MINI.dup, i, "Duplicar página")}
      ${doc.pages.length > 1 ? pageMini("delpage", PAGE_MINI.del, i, "Excluir página") : ""}
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
      <div class="pagebox" data-pageidx="${i}" style="width:${p.w}px; height:${p.h}px; background:${p.bg}; opacity:${p.hidden ? .45 : 1}">${p.els
        .map((e) => `<div class="el${e.locked ? " locked" : ""}" data-id="${e.id}" style="${elStyle(e)}">${elInner(e)}</div>`)
        .join("")}</div>
    </div>`).join("") +
    `<button class="addpagebtn" id="addPageCanvas" style="top:${stackHeight() + 20 / zoom}px; width:${stackW}px;">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      Adicionar página
    </button>`;
  // text auto-height, across every page
  for (const p of doc.pages) {
    for (const e of p.els) {
      if (e.type !== "text") continue;
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
      <div class="tag num" style="left:0;top:0">${els.length} selected</div>
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

const QALIGN_ICON = {
  left: `<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/>`,
  center: `<path d="M4 6h16"/><path d="M7 12h10"/><path d="M5.5 18h13"/>`,
  right: `<path d="M4 6h16"/><path d="M10 12h10"/><path d="M7 18h13"/>`,
};
const FLIP_H_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7L4 12l4 5z"/><path d="M16 7l4 5-4 5z"/></svg>`;
const FLIP_V_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M7 8l5-4 5 4z"/><path d="M7 16l5 4 5-4z"/></svg>`;
const REPLACE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 14l3-3 2.5 2.5L17 10l2 2"/><circle cx="8" cy="9" r="1.3"/></svg>`;
const LOCK_ICON = (locked: boolean) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${locked ? `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>` : `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>`}</svg>`;
const DUP_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const DEL_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const MORE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;

/* Fixed contextual bar (Toolbar): per-type controls for the current selection, docked
 * above the stage — never floats over the element itself. Mirrors the exact control set
 * Canva shows for text vs. photo vs. shape selections (see /Users/it4mi/Downloads/canva/*.html). */
function renderToolbar() {
  const bar = $("toolbar");
  const els = selEls().filter((e) => !e.hidden);
  // Stays in flow (never [hidden]) even with nothing selected — .toolbar's min-height
  // reserves the same space either way, so selecting/deselecting never shifts the stage.
  if (!els.length || editingId) {
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
    html += `<select id="tFont" class="qselect" title="Fonte">${FONTS.map((f) => `<option ${e.font === f ? "selected" : ""}>${f}</option>`).join("")}</select>`;
    html += `<div class="qsep"></div>`;
    html += `<button class="qbtn" id="tSizeDown" title="Diminuir corpo">−</button><input class="qsizeval num" id="tSize" type="number" min="6" max="512" value="${Math.round(e.size)}" aria-label="Tamanho da fonte"><button class="qbtn" id="tSizeUp" title="Aumentar corpo">+</button>`;
    html += `<div class="qsep"></div>`;
    html += `<input type="color" id="tFill" class="qcolor" title="Cor do texto" value="${/^#[0-9a-f]{6}$/i.test(e.fill) ? e.fill : "#000000"}">`;
    html += `<div class="qsep"></div>`;
    html += `<button class="qbtn" data-ttw="bold" aria-pressed="${e.weight >= 700}" style="font-weight:800" title="Negrito">B</button>`;
    html += `<button class="qbtn" data-ttw="italic" aria-pressed="${!!e.italic}" style="font-style:italic" title="Itálico">I</button>`;
    html += `<button class="qbtn" data-ttw="underline" aria-pressed="${!!e.underline}" style="text-decoration:underline" title="Sublinhado">U</button>`;
    html += `<div class="qsep"></div>`;
    html += (["left", "center", "right"] as const).map((a) => `<button class="qbtn" data-tta="${a}" aria-pressed="${e.align === a}" title="Alinhar ${PT_ALIGN[a]}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${QALIGN_ICON[a]}</svg></button>`).join("");
    html += `<div class="qsep"></div>`;
    html += `<div class="field" style="width:52px" title="Entrelinha"><input id="tLh" value="${e.lh}"></div>`;
    html += `<div class="field" style="width:52px" title="Espaçamento entre letras"><input id="tLs" value="${e.ls}"></div>`;
  } else if (one && t === "image") {
    html += `<button class="qbtn" id="tReplace" title="Substituir imagem">${REPLACE_ICON}</button>`;
    html += `<input type="color" id="tStroke" class="qcolor" title="Cor da borda" value="${/^#[0-9a-f]{6}$/i.test(e.stroke) ? e.stroke : "#FFFFFF"}">`;
    html += `<button class="qbtn" id="tRadDown" title="Diminuir raio dos cantos">⌐</button><span class="qsizeval num">${Math.round(e.radius || 0)}</span><button class="qbtn" id="tRadUp" title="Aumentar raio dos cantos">◠</button>`;
    html += `<button class="qbtn" data-tflip="h" title="Inverter na horizontal">${FLIP_H_ICON}</button>`;
    html += `<button class="qbtn" data-tflip="v" title="Inverter na vertical">${FLIP_V_ICON}</button>`;
  } else if (one) {
    const showFill = ["rect", "ellipse", "triangle", "star", "line", "icon"].includes(t);
    const showStroke = ["rect", "ellipse", "draw"].includes(t);
    const showRadius = t === "rect";
    if (showFill) html += `<input type="color" id="tFill" class="qcolor" title="Preenchimento" value="${/^#[0-9a-f]{6}$/i.test(e.fill) ? e.fill : "#000000"}">`;
    if (showStroke) html += `<input type="color" id="tStroke" class="qcolor" title="Cor da borda" value="${/^#[0-9a-f]{6}$/i.test(e.stroke) ? e.stroke : "#FFFFFF"}">`;
    if (showRadius) html += `<button class="qbtn" id="tRadDown" title="Diminuir raio dos cantos">⌐</button><span class="qsizeval num">${Math.round(e.radius || 0)}</span><button class="qbtn" id="tRadUp" title="Aumentar raio dos cantos">◠</button>`;
    html += `<button class="qbtn" data-tflip="h" title="Espelhar na horizontal">${FLIP_H_ICON}</button>`;
    html += `<button class="qbtn" data-tflip="v" title="Espelhar na vertical">${FLIP_V_ICON}</button>`;
  }

  html += `<div class="qsep"></div>`;
  html += `<div class="field" style="width:74px" title="Transparência"><input type="range" id="tOp" min="0" max="100" value="${Math.round((e.opacity ?? 1) * 100)}"></div>`;
  html += `<div class="qsep"></div>`;
  html += `<button class="qbtn" id="tPosition" aria-pressed="${propPopOpen && panelTab === "organize"}" title="Posição">Posição</button>`;
  html += `<button class="qbtn" id="tLayers" title="Camadas">Camadas</button>`;

  bar.innerHTML = html;
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
    renderToolbar(); return;
  }
  const ta = t.closest<HTMLElement>("[data-tta]");
  if (ta) { patch({ align: ta.dataset.tta }, true); renderToolbar(); return; }
  const tf = t.closest<HTMLElement>("[data-tflip]");
  if (tf) { flip(tf.dataset.tflip); return; }
  if (t.closest("#tSizeUp")) { const e = selEls()[0]; patch({ size: (e.size || 16) + 2 }, true); renderToolbar(); return; }
  if (t.closest("#tSizeDown")) { const e = selEls()[0]; patch({ size: Math.max(6, (e.size || 16) - 2) }, true); renderToolbar(); return; }
  if (t.closest("#tRadUp")) { const e = selEls()[0]; patch({ radius: Math.max(0, (e.radius || 0) + 4) }, true); renderToolbar(); return; }
  if (t.closest("#tRadDown")) { const e = selEls()[0]; patch({ radius: Math.max(0, (e.radius || 0) - 4) }, true); renderToolbar(); return; }
  if (t.closest("#tReplace")) { $("fileImgReplace").click(); return; }
  if (t.closest("#tPosition")) { propPopOpen = true; panelTab = "organize"; renderProps(); positionFloatingUI(); return; }
});
$("toolbar").addEventListener("input", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === "tFill") patch({ fill: t.value });
  if (t.id === "tFont") patch({ font: t.value }, true);
  if (t.id === "tSize" && Number(t.value) >= 6) patch({ size: clamp(Number(t.value), 6, 512) });
  if (t.id === "tStroke") patch({ stroke: t.value });
  if (t.id === "tOp") patch({ opacity: clamp(parseFloat(t.value) / 100, 0, 1) });
  if (t.id === "tLh") { const n = parseFloat(t.value); if (n > 0) patch({ lh: n }); }
  if (t.id === "tLs") { const n = parseFloat(t.value); patch({ ls: n || 0 }); }
});
$("toolbar").addEventListener("change", (ev) => {
  const id = (ev.target as HTMLElement).id;
  if (id === "tSize") {
    const input = ev.target as HTMLInputElement;
    const size = Number(input.value);
    if (!Number.isFinite(size) || size < 6) { input.value = String(selEls()[0]?.size ?? 16); return; }
    input.value = String(clamp(size, 6, 512));
  }
  if (["tFill", "tStroke", "tOp", "tLh", "tLs", "tSize"].includes(id)) commit();
});
$("toolbar").addEventListener("keydown", (ev) => {
  if (ev.target.id === "tSize" && ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
});
$("toolbar").addEventListener("focusout", (ev) => {
  if (ev.target.id !== "tSize") return;
  ev.target.value = String(selEls()[0]?.size ?? 16);
  if (snap() !== baseline) commit();
});

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
  html += `<button class="qbtn" id="qDel" title="Excluir (⌫)" style="color:var(--danger)">${DEL_ICON}</button>`;
  html += `<button class="qbtn" id="qMore" aria-pressed="${ctxMenuOpen}" title="Mais">${MORE_ICON}</button>`;
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
    <button class="ctxitem" data-ctx="copy" ${dis(hasSel)}>Copiar<span class="ctxkey">⌘C</span></button>
    <button class="ctxitem" disabled title="Sem suporte ainda">Copiar estilo<span class="ctxkey">⌥⌘C</span></button>
    <button class="ctxitem" data-ctx="paste" ${dis(!!clipboard?.length)}>Colar<span class="ctxkey">⌘V</span></button>
    <button class="ctxitem" data-ctx="duplicate" ${dis(hasSel)}>Duplicar<span class="ctxkey">⌘D</span></button>
    <button class="ctxitem danger" data-ctx="delete" ${dis(hasSel)}>Excluir<span class="ctxkey">DELETE</span></button>
    <div class="ctxsep"></div>
    <button class="ctxitem" data-ctx="group" ${dis(canGroup)}>Agrupar<span class="ctxkey">⌘G</span></button>
    <button class="ctxitem" data-ctx="ungroup" ${dis(canUngroup)}>Desagrupar<span class="ctxkey">⇧⌘G</span></button>
    <div class="ctxsep"></div>
    <div class="ctxitem has-sub">Camada<span class="ctxarrow">›</span>
      <div class="ctxsub">
        ${CTX_ORDER.map(([k, label]) => `<button class="ctxitem" data-ctxorder="${k}" ${dis(hasSel)}>${label}</button>`).join("")}
      </div>
    </div>
    <div class="ctxitem has-sub">Alinhar à página<span class="ctxarrow">›</span>
      <div class="ctxsub ctxalign">
        ${CTX_ALIGN.map(([k, label]) => `<button class="ctxitem" data-ctxalign="${k}" ${dis(hasSel)}>${label}</button>`).join("")}
      </div>
    </div>
    <div class="ctxsep"></div>
    <button class="ctxitem" data-ctx="lock" ${dis(hasSel)}>${locked ? "Desbloquear" : "Bloquear"}</button>
    <button class="ctxitem" disabled title="Sem suporte ainda">Adicionar link<span class="ctxkey">⌘K</span></button>
  `;
}
$("ctxmenu").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  if (b.dataset.ctx === "copy") copySel();
  else if (b.dataset.ctx === "paste") paste();
  else if (b.dataset.ctx === "duplicate") duplicateSel();
  else if (b.dataset.ctx === "delete") deleteSel();
  else if (b.dataset.ctx === "group") groupSel();
  else if (b.dataset.ctx === "ungroup") ungroupSel();
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
  // The floating selection toolbar, its "more options" popover, the tool belt, the bottom
  // bar, the thumbnail strip, and each page's own floating header/add-page button are UI
  // chrome living inside .stage — not canvas content, so a click there must never fall
  // through to marquee-select.
  if ((ev.target as HTMLElement).closest("#seltoolbar, #proppop, #documentScroll, #ctxmenu, .pagehead, #addPageCanvas")) return;
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
      s.innerHTML = `<path d="${pts.map((q, i) => `${i ? "L" : "M"}${q[0] - b.x},${q[1] - b.y}`).join(" ")}" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
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
        name: "Desenho",
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
  t.setAttribute("contenteditable", "true");
  t.focus();
  document.getSelection().selectAllChildren(t);
  t.addEventListener("blur", stopEditing, { once: true });
}
function stopEditing() {
  if (!editingId) return;
  const t = $("pagestack").querySelector(`[data-txt="${editingId}"]`);
  const el = byId(editingId);
  if (t && el) {
    const v = t.innerText.replace(/ /g, " ").replace(/\n$/, "");
    t.removeAttribute("contenteditable");
    if (v !== el.text) { el.text = v; commit(); }
  }
  editingId = null;
  renderAll();
}

/* scroll + zoom wheel */
$("stage").addEventListener("wheel", (ev) => {
  if ((ev.target as HTMLElement).closest("#proppop, #seltoolbar, #ctxmenu, #documentScroll")) return;
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
  for (const p of doc.pages) p.els = p.els.filter((e) => !sel.includes(e.id) || e.locked);
  if (!locked) sel = [];
  commit(); renderAll();
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
    if (e.type === "draw") e.pts = e.pts.map((p) => axis === "h" ? [1 - p[0], p[1]] : [p[0], 1 - p[1]]);
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
  { id: "text", label: "Texto", icon: `<path d="M4 6h16"/><path d="M12 6v14"/>` },
  { id: "elements", label: "Formas", icon: `<circle cx="9" cy="9" r="5"/><rect x="11" y="11" width="9" height="9" rx="1.5"/>` },
  { id: "uploads", label: "Imagens", icon: `<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 15.5l5-5 4 4 3.5-3.5 4.5 4.5"/><circle cx="8.5" cy="8.5" r="1.4"/>` },
  { id: "draw", label: "Desenho", icon: `<path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/><path d="M13.5 7.5l3 3"/>` },
  { id: "page", label: "Tela", icon: `<path d="M12 3s6.5 6.8 6.5 10.5A6.5 6.5 0 1 1 5.5 13.5C5.5 9.8 12 3 12 3z"/>` },
];
function renderRail() {
  $("rail").innerHTML = TABS.map((t) => `
    <button class="railbtn" data-tab="${t.id}" aria-pressed="${activeTab === t.id}" title="${t.label}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
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
  if (fitView) zoomFit();
  else { clampView(); applyWorld(); renderOverlay(); }
}

function renderPanel() {
  const el = $("panel");
  el.classList.remove("pages-index");
  if (!activeTab) { el.hidden = true; return; }
  el.hidden = false;
  const P = page();
  if (activeTab === "text") {
    el.innerHTML = `<h4 class="ptitle">Texto</h4><p class="phint">Clique para adicionar. Dê duplo clique em qualquer texto da tela para editá-lo no lugar.</p>
      <button class="texttile" data-add="text" data-size="88" data-weight="700" title="Adicionar título" style="font-size:21px;font-weight:700">Título</button>
      <button class="texttile" data-add="text" data-size="52" data-weight="600" title="Adicionar subtítulo" style="font-size:16px;font-weight:600">Subtítulo</button>
      <button class="texttile" data-add="text" data-size="30" data-weight="400" title="Adicionar corpo de texto" style="font-size:13px">Corpo de texto</button>`;
  }
  if (activeTab === "elements") {
    const shapes = [
      ["rect", "Retângulo", `<rect x="3" y="6" width="18" height="12" rx="2"/>`],
      ["ellipse", "Elipse", `<circle cx="12" cy="12" r="9"/>`],
      ["triangle", "Triângulo", `<polygon points="12,3 21,20 3,20"/>`],
      ["star", "Estrela", `<polygon points="12,3 14.6,9.3 21,9.9 16.2,14.2 17.6,20.5 12,17.2 6.4,20.5 7.8,14.2 3,9.9 9.4,9.3"/>`],
      ["line", "Linha", `<rect x="3" y="11" width="18" height="2.5" rx="1.2"/>`],
    ];
    el.innerHTML = `<h4 class="ptitle">Formas</h4><p class="phint">Formas vetoriais que você reestiliza no painel de propriedades.</p>
      <div class="grid2">${shapes.map(([t, n, ic]) => `
        <button class="tile" data-add="${t}" title="Adicionar ${n.toLowerCase()}"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">${ic}</svg>${n}</button>`).join("")}</div>`;
  }
  if (activeTab === "uploads") {
    el.innerHTML = `<h4 class="ptitle">Imagens</h4><p class="phint">Suas próprias imagens, deste dispositivo. Ficam guardadas dentro do design.</p>
      <button class="dropzone" id="pickImg" title="Escolher imagens do dispositivo">Escolher imagens…</button>
      <p class="phint">Nada aqui vem de banco de imagens.</p>`;
  }
  if (activeTab === "draw") {
    el.innerHTML = `<h4 class="ptitle">Desenho</h4><p class="phint">Caneta à mão livre. Cada traço vira uma camada editável.</p>
      <button class="tile" style="width:100%;height:44px;flex-direction:row;gap:8px" id="drawOn" aria-pressed="${tool === "draw"}" title="${tool === "draw" ? "Parar de desenhar" : "Começar a desenhar"}">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/></svg>
        ${tool === "draw" ? "Desenhando — clique para parar" : "Começar a desenhar"}</button>`;
  }
  if (activeTab === "page") {
    el.innerHTML = `<h4 class="ptitle">Tela</h4><p class="phint">Cor de fundo e tamanho da tela na página ${doc.active + 1}.</p>
      <div class="sec"><h4>Fundo</h4>
        <div class="grid4" style="margin-bottom:8px">${PALETTE.slice(0, 8).map((c) => `<button class="swatch" data-bg="${c}" aria-pressed="${P.bg.toLowerCase() === c}" title="Fundo da página ${c}" style="background:${c}"></button>`).join("")}</div>
        <div class="field"><label>Hex</label><input type="color" id="bgPick" value="${P.bg}"></div>
      </div>
      <div class="sec"><h4>Fundo do canvas</h4><p class="phint" style="margin-bottom:8px">A área ao redor da página — não o conteúdo dela.</p>
        <div class="grid4" style="margin-bottom:8px">${STAGE_BG_PRESETS.map((c) => `<button class="swatch" data-stagebg="${c}" aria-pressed="${(stageBg || "").toLowerCase() === c.toLowerCase()}" title="Fundo do canvas ${c}" style="background:${c}"></button>`).join("")}</div>
        <div class="row" style="margin-bottom:8px"><button class="tbtn ghost" data-stagebg-reset style="flex:1;height:30px;font-size:11.5px" aria-pressed="${!stageBg}">Seguir o tema</button></div>
        <div class="field"><label>Hex</label><input type="color" id="stageBgPick" value="${stageBg || stageGroundHex()}"></div>
      </div>
      <div class="sec"><h4>Tamanho</h4><p class="phint" style="margin-bottom:8px">Aplica a todas as páginas do documento.</p>
        <div class="grid2" style="margin-bottom:8px">${PAGE_SIZES.map((s) => `<button class="tile" style="height:46px;font-size:10px" data-size="${s.w}x${s.h}">${s.n}<span class="num" style="color:var(--faint)">${s.w}×${s.h}</span></button>`).join("")}</div>
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
  box.innerHTML = `<p class="phint" id="layerDragHint">Arraste para reordenar. O topo da lista fica na frente.<br>Ou use Alt + ↑ / ↓ na alça da camada.</p>` +
    `<div class="layer-list" role="list" aria-label="Camadas da página ${doc.active + 1}">` +
    (P.els.length ? [...P.els].reverse().map((e) => {
      const scale = Math.min(32 / Math.max(1, e.w), 32 / Math.max(1, e.h));
      return `<div class="layer${e.hidden ? " is-hidden" : ""}" data-layer="${esc(e.id)}" data-selected="${sel.includes(e.id)}" role="listitem">
        <button class="layer-grip" data-layer-grip="${esc(e.id)}" aria-label="Arrastar camada ${esc(e.name)}" aria-describedby="layerDragHint" title="${e.locked ? "Desbloqueie para reordenar" : "Arrastar para reordenar · Alt + ↑ / ↓"}" aria-disabled="${e.locked}">
          <svg width="12" height="20" viewBox="0 0 12 20" fill="currentColor"><circle cx="3" cy="5" r="1.2"/><circle cx="9" cy="5" r="1.2"/><circle cx="3" cy="10" r="1.2"/><circle cx="9" cy="10" r="1.2"/><circle cx="3" cy="15" r="1.2"/><circle cx="9" cy="15" r="1.2"/></svg>
        </button>
        <button class="layer-select" aria-label="Selecionar camada ${esc(e.name)}" aria-pressed="${sel.includes(e.id)}">
          <span class="layer-preview" aria-hidden="true"><span class="layer-preview-art" style="width:${e.w}px;height:${e.h}px;left:${(40 - e.w * scale) / 2}px;top:${(40 - e.h * scale) / 2}px;transform:scale(${scale})">${elInner(e)}</span></span>
          <span class="lname" title="${esc(e.name)}">${esc(e.name)}<small>${TYPE_PT[e.type] || "Elemento"}${e.group ? " · grupo" : ""}${e.locked ? " · bloqueada" : ""}</small></span>
        </button>
        <button class="mini" data-layer-lock="${esc(e.id)}" title="${e.locked ? "Desbloquear" : "Bloquear"}" aria-label="${e.locked ? "Desbloquear" : "Bloquear"} camada ${esc(e.name)}">${LOCK_ICON(e.locked)}</button>
        <button class="mini" data-hide="${esc(e.id)}" title="${e.hidden ? "Mostrar" : "Ocultar"}" aria-label="${e.hidden ? "Mostrar" : "Ocultar"} camada ${esc(e.name)}">
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
  if (bg) { page().bg = bg.dataset.bg; commit(); renderAll(); return; }
  if (ev.target.closest("[data-stagebg-reset]")) { stageBg = null; applyStageBg(); renderPanel(); return; }
  const sbg = ev.target.closest("[data-stagebg]");
  if (sbg) { stageBg = sbg.dataset.stagebg; applyStageBg(); renderPanel(); return; }
  const sz = ev.target.closest("[data-size]:not([data-add])");
  if (sz) {
    const [w, h] = sz.dataset.size.split("x").map(Number);
    for (const p of doc.pages) { p.w = w; p.h = h; }
    commit(); renderAll(); zoomFit(); return;
  }
  if (ev.target.closest("#pickImg")) { $("fileImg").click(); return; }
  if (ev.target.closest("#drawOn")) { setTool(tool === "draw" ? "select" : "draw"); return; }
});
$("panel").addEventListener("input", (ev) => {
  if (ev.target.id === "bgPick") { page().bg = ev.target.value; renderCanvas(); }
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

  const box = $("props");
  const els = selEls();
  if (!els.length) {
    box.innerHTML = `<p class="empty">Nada selecionado.</p>`;
    return;
  }
  const e = els[0];
  const one = els.length === 1;

  box.innerHTML = `
    ${one ? `<div class="sec"><h4>Camada</h4><div class="field" title="Nome desta camada — é o que aparece na lista Camadas"><input id="pName" value="${esc(e.name)}" style="font-family:var(--body)"></div></div>` : `<div class="sec"><h4>${els.length} objetos selecionados</h4></div>`}

    <div class="sec"><h4>Organizar</h4>
      <div class="seg order-actions" style="margin-bottom:12px">
        ${[["front", "Para o topo", `<rect width="8" height="8" x="8" y="8" rx="2"/><path d="M4 10a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2"/><path d="M14 20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2"/>`],
           ["up", "Para frente", `<path d="m18 15-6-6-6 6"/>`],
           ["down", "Para trás", `<path d="m6 9 6 6 6-6"/>`],
           ["back", "Para o fundo", `<rect width="8" height="8" x="14" y="14" rx="2"/><rect width="8" height="8" x="2" y="2" rx="2"/><path d="M7 14v1a2 2 0 0 0 2 2h1"/><path d="M14 7h1a2 2 0 0 1 2 2v1"/>`]]
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
      <div class="seg">
        <button data-flip="h" title="Espelhar na horizontal"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m3 7 5 5-5 5V7"/><path d="m21 7-5 5 5 5V7"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/></svg></button>
        <button data-flip="v" title="Espelhar na vertical"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m17 3-5 5-5-5h10"/><path d="m17 21-5-5-5 5h10"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/></svg></button>
        <button data-cmd="duplicate" title="Duplicar (⌘D)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
        <button data-cmd="delete" title="Excluir (⌫)" style="color:var(--danger)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
    </div>

    ${one ? `<div class="sec"><h4>Avançados</h4>
      <div class="grid2" style="gap:6px">
        <div class="field" title="Largura, em px"><label>L</label><input id="pW" value="${Math.round(e.w)}"></div>
        <div class="field" title="${e.type === "text" ? "Altura — automática no texto, definida pelo conteúdo" : "Altura, em px"}"><label>A</label><input id="pH" value="${Math.round(e.h)}" ${e.type === "text" ? "disabled" : ""}></div>
        <div class="field" title="X — distância da borda esquerda da página, em px"><label>X</label><input id="pX" value="${Math.round(e.x)}"></div>
        <div class="field" title="Y — distância do topo da página, em px"><label>Y</label><input id="pY" value="${Math.round(e.y)}"></div>
        <div class="field" title="Rotação, em graus"><label>∠</label><input id="pR" value="${Math.round(e.rot)}"></div>
      </div></div>` : ""}`;
}

$("ptabs")?.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-ptab]");
  if (!b) return;
  panelTab = b.dataset.ptab as "organize" | "layers";
  renderProps();
});
$("closeProps").addEventListener("click", () => { propPopOpen = false; positionFloatingUI(); });
$("props").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
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
  if (g("flip")) return flip(g("flip").dataset.flip);
  if (g("cmd")) return g("cmd").dataset.cmd === "delete" ? deleteSel() : duplicateSel();
});
$("props").addEventListener("input", (ev) => {
  const id = (ev.target as HTMLElement).id, v = (ev.target as HTMLInputElement).value, n = parseFloat(v);
  const map = {
    pX: () => patch({ x: n || 0 }), pY: () => patch({ y: n || 0 }),
    pW: () => n > 0 && patch({ w: n }), pH: () => n > 0 && patch({ h: n }),
    pR: () => patch({ rot: n || 0 }), pName: () => patch({ name: v }),
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
  up: `<path d="M12 19V6"/><path d="M6 11l6-5 6 5"/>`,
  down: `<path d="M12 5v13"/><path d="M6 13l6 5 6-5"/>`,
  hideOn: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.6"/>`,
  hideOff: `<path d="M3 3l18 18"/><path d="M10.6 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.4 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.3 0 2.5-.3 3.6-.7"/>`,
  dup: `<rect x="3" y="3" width="13" height="13" rx="2"/><rect x="8" y="8" width="13" height="13" rx="2"/>`,
  del: `<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>`,
};
const pageMini = (action: string, icon: string, i: number, title: string, disabled = false) => `
  <button class="pmini${["moveuppage", "movedownpage", "hidepage"].includes(action) ? " page-secondary" : ""}" data-${action}="${i}" title="${title}" aria-label="${title}" ${disabled ? "disabled" : ""}>
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
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
});

/* ---------- thumbnail strip ---------- */
function renderThumbStrip() {
  $("thumbstrip").innerHTML = doc.pages.map((p, i) => `
    <button class="thumbitem" data-gopage="${i}" aria-pressed="${i === doc.active}" aria-label="Página ${i + 1}" title="Página ${i + 1}${p.hidden ? " · oculta" : ""}">
      <div class="thumbitempic" style="background:${p.bg}; aspect-ratio:${p.w}/${p.h}; opacity:${p.hidden ? .45 : 1}">${thumbs.has(p.id)
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
  $("docViewBtn").setAttribute("aria-pressed", String(m === "document"));
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
$("docViewBtn").addEventListener("click", () => setPagesMode("document"));
$("thumbViewBtn").addEventListener("click", () => setPagesMode("thumb"));
$("gridViewBtn").addEventListener("click", () => setPagesMode("grid"));
$("pageCountBtn").addEventListener("click", () => setPagesMode("grid"));

/* ---------- grid view ---------- */
function renderGridView() {
  $("gridview").innerHTML = doc.pages.map((p, i) => `
    <button class="gridcell" data-gridpage="${i}" aria-pressed="${i === doc.active}" title="Abrir página ${i + 1}">
      <div class="pt" style="background:${p.bg}; aspect-ratio:${p.w}/${p.h}; opacity:${p.hidden ? .45 : 1}">${thumbs.has(p.id)
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
let downloads = null;
if (window.claude?.use) {
  window.claude.use("downloads").then((d) => { downloads = d; }).catch(() => {});
}
let expFmt = "png", expScale = 2;

function renderExport() {
  $("fmts").innerHTML = ["png", "jpg", "pdf", "json"].map((f) =>
    `<button class="fmt" data-fmt="${f}" aria-pressed="${expFmt === f}" title="Exportar como ${f.toUpperCase()}">${f.toUpperCase()}</button>`).join("");
  $("scales").innerHTML = [1, 2, 3].map((s) =>
    `<button data-scale="${s}" aria-pressed="${expScale === s}" title="Escala ${s}×">${s}×</button>`).join("");
  $("scales").parentElement.style.display = (expFmt === "json") ? "none" : "";
}
$("exportBtn").addEventListener("click", () => { renderExport(); $("scrim").hidden = false; });
$("expCancel").addEventListener("click", () => { $("scrim").hidden = true; });
$("scrim").addEventListener("click", (e) => { if (e.target === $("scrim")) $("scrim").hidden = true; });
$("scrim").addEventListener("click", (e) => {
  const f = e.target.closest("[data-fmt]"); if (f) { expFmt = f.dataset.fmt; renderExport(); }
  const s = e.target.closest("[data-scale]"); if (s) { expScale = +s.dataset.scale; renderExport(); }
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

async function renderPageCanvas(p: Page, scale: number) {
  const c = document.createElement("canvas");
  c.width = Math.round(p.w * scale); c.height = Math.round(p.h * scale);
  const x = c.getContext("2d");
  x.scale(scale, scale);
  x.fillStyle = p.bg; x.fillRect(0, 0, p.w, p.h);
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
async function drawEl(x: CanvasRenderingContext2D, e: any) {
  const stroke = () => { if (e.stroke && e.strokeWidth) { x.strokeStyle = e.stroke; x.lineWidth = e.strokeWidth; x.stroke(); } };
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
  else if (e.type === "line") { roundRect(x, e.w, e.h, e.h / 2); x.fillStyle = paintOf(x, e); x.fill(); }
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
    x.beginPath();
    (e.pts || []).forEach((p, i) => { const px = p[0] * e.w, py = p[1] * e.h; i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.strokeStyle = e.stroke; x.lineWidth = e.strokeWidth; x.lineCap = "round"; x.lineJoin = "round"; x.stroke();
  }
  else if (e.type === "image" && srcOf(e)) {
    try {
      const img = await loadImg(srcOf(e));
      x.save(); roundRect(x, e.w, e.h, e.radius || 0); x.clip();
      const r = Math.max(e.w / img.width, e.h / img.height);
      const dw = img.width * r, dh = img.height * r;
      x.drawImage(img, (e.w - dw) / 2, (e.h - dh) / 2, dw, dh);
      x.restore(); stroke();
    } catch (err) { /* unreadable image, skip */ }
  }
  else if (e.type === "text") {
    x.fillStyle = e.fill;
    x.font = `${e.italic ? "italic " : ""}${e.weight} ${e.size}px "${e.font}", Inter, system-ui, sans-serif`;
    x.textBaseline = "top";
    const lh = e.size * e.lh;
    const lines = [];
    for (const para of String(e.text).split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const t = line ? line + " " + word : word;
        if (x.measureText(t).width > e.w && line) { lines.push(line); line = word; }
        else line = t;
      }
      lines.push(line);
    }
    lines.forEach((ln, i) => {
      const w = x.measureText(ln).width;
      const tx = e.align === "center" ? (e.w - w) / 2 : e.align === "right" ? e.w - w : 0;
      const ty = i * lh + (lh - e.size) / 2;
      x.fillText(ln, tx, ty);
      if (e.underline) { x.fillRect(tx, ty + e.size * 1.02, w, Math.max(1, e.size / 16)); }
    });
  }
}

async function doExport() {
  const name = (doc.name || "design").replace(/[^\w \-]/g, "").trim() || "design";
  $("scrim").hidden = true;
  if (!downloads) { toast("Download não está disponível nesta visualização."); return; }
  try {
    await document.fonts.ready;
    if (expFmt === "json") {
      await downloads.save({ filename: `${name}.json`, data: JSON.stringify(doc, null, 2) });
      toast("Salvo"); return;
    }
    if (expFmt === "pdf") {
      const pgs = [];
      for (const p of doc.pages.filter((p) => !p.hidden)) {
        const c = await renderPageCanvas(p, expScale);
        const b64 = c.toDataURL("image/jpeg", 0.92).split(",")[1];
        pgs.push({ bytes: b64ToBytes(b64), pw: c.width, ph: c.height, w: p.w, h: p.h });
      }
      await downloads.save({ filename: `${name}.pdf`, data: buildPDF(pgs) });
      toast("Salvo"); return;
    }
    const p = page();
    const c = await renderPageCanvas(p, expScale);
    const mime = expFmt === "jpg" ? "image/jpeg" : "image/png";
    const blob = await new Promise((r) => c.toBlob(r, mime, 0.94));
    await downloads.save({ filename: `${name}-page-${doc.active + 1}.${expFmt}`, data: blob });
    toast("Salvo");
  } catch (err) {
    const code = err?.code;
    if (code === "declined") return;
    if (code === "extension_not_enabled") { toast("PDF não está habilitado aqui — use PNG ou JPG."); return; }
    if (code === "too_large") { toast("Muito grande — tente uma escala menor."); return; }
    if (code === "rate_limited") { toast("Um download por vez — tente de novo em instantes."); return; }
    toast("Falha ao exportar: " + (err?.message || code || "desconhecido"));
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
    toast("Template excluído");
    location.hash = "/console/templates";
  } catch { toast("Não foi possível excluir."); }
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
$("zoomval").onclick = () => { const r = $("stage").getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1); };
$("zoomin").onclick = () => { const r = $("stage").getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, zoom * 1.2); };
$("zoomout").onclick = () => { const r = $("stage").getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, zoom / 1.2); };
$("zoomfit").onclick = zoomFit;
$("docname").addEventListener("input", (e) => { doc.name = e.target.value; persist(); });
$("docname").addEventListener("change", commit);
$("undoBtn").addEventListener("click", undo);
$("redoBtn").addEventListener("click", redo);

const typing = () => {
  const a = document.activeElement;
  const el = a as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
};
window.addEventListener("keydown", (e) => {
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
  if (mod && k === "c") { e.preventDefault(); copySel(); return; }
  if (mod && k === "v") { e.preventDefault(); paste(); return; }
  if (mod && k === "d") { e.preventDefault(); duplicateSel(); return; }
  if (mod && k === "g") { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return; }
  if (mod && k === "a") { e.preventDefault(); sel = page().els.filter((x) => !x.hidden).map((x) => x.id); renderAll(); return; }
  if (mod && (k === "=" || k === "+")) { e.preventDefault(); $("zoomin").click(); return; }
  if (mod && k === "-") { e.preventDefault(); $("zoomout").click(); return; }
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
  if (e.code === "Space") { spaceDown = false; $("stage").style.cursor = tool === "hand" ? "grab" : tool === "draw" ? "crosshair" : "default"; }
});

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}



/* ============================ boot ============================ */
function renderAll() {
  renderCanvas(); renderProps(); renderLayers();
}

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
  // Encodes which template is open in the URL itself — without this, reloading (or opening a
  // shared link) has no way to know which document to restore and falls back to a blank one.
  // A real hash assignment (not history.replaceState) so the top-level router's hashchange
  // listener actually fires and switches the visible route — otherwise clicking a template from
  // the console silently updated the URL but left the console on screen until a manual reload.
  const target = `#/editor/${encodeURIComponent(id)}`;
  if (location.hash !== target) location.hash = target;
  try {
    openTemplateDocument(await fetchTemplateFromServer(id));
    return;
  } catch { /* offline, or not created on the server yet — fall back to whatever's local */ }
  finally { if (loadingTemplateId === id) loadingTemplateId = null; }
  const local = loadTemplateLocally(id) ?? (id === TWEET_TEMPLATE_ID ? createTweetTemplateDocument() : null);
  if (local) openTemplateDocument(local);
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
  return d;
}

export function openTemplateDocument(templateDoc: Doc) {
  doc = normalizeDoc(templateDoc);
  // As fontes do design chegam junto com o documento e não estão carregadas ainda; redesenha
  // quando chegarem, senão o canvas fica com a medida da fonte de fallback.
  loadDesignFonts(doc).then(() => { if (editorMounted) renderAll(); });
  doc.active = clamp(doc.active | 0, 0, doc.pages.length - 1);
  pendingDocument = true;
  sel = [];
  past = [];
  future = [];
  baseline = snap();
  if (editorMounted) {
    $("docname").value = doc.name;
    renderAll();
    syncHistory();
    buildThumbs();
    requestAnimationFrame(zoomFit);
  }
}

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
  renderRail(); renderPanel(); renderAll(); buildThumbs(); syncHistory();
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
