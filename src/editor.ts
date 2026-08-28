import "./styles.css";
import { b64ToBytes, buildPDF } from "./pdf";
import type { Doc, El, Page } from "./types";
import { createTweetTemplateDocument, TWEET_TEMPLATE_ID } from "./tweetTemplateDoc";
import { fetchTemplateFromServer, loadTemplateLocally, saveTemplateLocally, syncTemplateToServer, createTemplateOnServer, deleteTemplateOnServer } from "./templateStore";

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
const PT_ALIGN = { left: "à esquerda", cx: "ao centro", right: "à direita", top: "ao topo", cy: "ao meio", bottom: "à base" };
const PALETTE = ["#FCFCFA", "#E3E2DE", "#C4C2BC", "#9B9992", "#6E6C67", "#4A4944", "#2E2D29", "#111111"];
const STAGE_BG_PRESETS = ["#0A0A09", "#1A1A18", "#2E2D29", "#4A4944", "#6E6C67", "#9B9992", "#C4C2BC", "#E3E2DE"];

/* ============================ state ============================ */
const blankPage = () => ({ id: uid(), w: 1080, h: 1080, bg: "#111111", els: [] });
const SEED: Doc = { name: "Design sem título", pages: [blankPage()], active: 0 } as Doc;
let doc: Doc = SEED;
let sel: string[] = [];
let tool = "select";
let zoom = 1, panX = 0, panY = 0;
// The workspace behind the page — separate from the page's own "Fundo" fill (that's the
// artboard's content; this is just the room around it). Remembered per-browser, not per-doc.
const STAGE_BG_KEY = "blank-editor-stage-bg";
let stageBg = (() => { try { return localStorage.getItem(STAGE_BG_KEY) || "#0A0A09"; } catch { return "#0A0A09"; } })();
function applyStageBg() {
  $("stage").style.background = stageBg;
  try { localStorage.setItem(STAGE_BG_KEY, stageBg); } catch { /* blocked storage */ }
}
let past: string[] = [], future: string[] = [];
let clipboard = null;
let editingId = null;
let lastClickId: string | null = null;
let lastClickTime = 0;
// Whether the "⋯ Mais opções" popover (the old full properties panel) is open —
// reset to closed whenever the selection itself changes, but left alone across
// property edits on the same selection so it doesn't snap shut mid-adjustment.
let propPopOpen = false;
let propPopKey = "";
let activeTab = "elements";
const imgCache = new Map<string, HTMLImageElement>();

// Pages stack vertically in one continuous canvas (Canva-style), separated by this gap —
// wide enough to fit each page's floating header (label + move/hide/duplicate/delete).
const PAGE_GAP = 64;
function pageTop(i: number): number {
  let y = 0;
  for (let k = 0; k < i; k++) y += doc.pages[k].h + PAGE_GAP;
  return y;
}
function stackHeight(): number {
  return doc.pages.length ? pageTop(doc.pages.length - 1) + doc.pages[doc.pages.length - 1].h : 0;
}
function stackWidth(): number {
  return doc.pages.reduce((m, p) => Math.max(m, p.w), 0);
}
/** Which page a world Y falls into — the gap between pages splits down the middle. */
function pageIndexAtWorldY(y: number): number {
  for (let i = 0; i < doc.pages.length; i++) {
    if (y < pageTop(i) + doc.pages[i].h + PAGE_GAP / 2) return i;
  }
  return doc.pages.length - 1;
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
const srcOf = (e) => (e.src && e.src[0] === "@" ? (doc.assets && doc.assets[e.src.slice(1)]) || "" : e.src || "");


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
  const o = JSON.parse(json);
  doc = o.d; sel = o.s.filter((id) => o.d.pages.some((p) => p.els.some((e) => e.id === id)));
  editingId = null;
  $("docname").value = doc.name;
  renderAll();
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
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { localStorage.setItem(LS, JSON.stringify(doc)); } catch (e) { /* quota or blocked */ }
    saveTemplateLocally(doc);
    syncTemplateToServer(doc);
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
    fill: "#9B9992", stroke: "", strokeWidth: 0, radius: 0,
  };
  const spec = {
    rect: { w: 320, h: 220, radius: 8 },
    ellipse: { w: 260, h: 260 },
    triangle: { w: 280, h: 240 },
    star: { w: 260, h: 260 },
    line: { w: 320, h: 6, fill: "#FCFCFA" },
    text: {
      w: 520, h: 90, fill: "#FCFCFA", text: "Your text here", font: "Inter",
      size: 64, weight: 700, italic: false, underline: false, align: "left",
      lh: 1.2, ls: 0,
    },
    image: { w: 420, h: 300, radius: 0 },
    icon: { w: 24, h: 24, fill: "#FCFCFA", viewBox: "0 0 24 24", path: "" },
    draw: { fill: "none", stroke: "#FCFCFA", strokeWidth: 6, pts: [] },
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
    <span class="plabel2">Página ${i + 1}${p.hidden ? " · oculta" : ""}</span>
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
    `<div class="addpagebtn" id="addPageCanvas" style="top:${stackHeight() + PAGE_GAP / 2 - 20}px; width:${stackW}px;">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      Adicionar página
    </div>`;
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
  applyWorld();
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
  }
}

function applyWorld() {
  $("world").style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  $("ovl").style.setProperty("--inv", 1 / zoom);
  $("zoomval").textContent = Math.round(zoom * 100) + "%";
  $("pagecount").textContent = `${doc.active + 1} / ${doc.pages.length}`;
  const o = $("ovl");
  o.style.width = stackWidth() + "px";
  o.style.height = stackHeight() + "px";
  positionFloatingUI();
}

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
      ${hs.map(([k, fx, fy]) => `<div class="hdl" data-h="${k}" style="left:${fx * 100}%;top:${fy * 100}%;cursor:${CURSORS[k]};pointer-events:auto"></div>`).join("")}
      ${e.locked ? "" : `<div class="hdl rot" data-h="rot" style="left:50%;top:0;margin-top:-26px;cursor:grab;pointer-events:auto"></div>`}
    </div>`;
  } else {
    const b = bbox(els);
    html += `<div class="box multi" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px">
      <div class="tag num" style="left:0;top:0">${els.length} selected</div>
      ${["nw", "ne", "se", "sw"].map((k) => {
        const [, fx, fy] = HANDLES.find((h) => h[0] === k);
        return `<div class="hdl" data-h="${k}" data-multi="1" style="left:${fx * 100}%;top:${fy * 100}%;cursor:${CURSORS[k]};pointer-events:auto"></div>`;
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
  const key = sel.join(",");
  if (key !== propPopKey) { propPopKey = key; propPopOpen = false; }
  if (!els.length || editingId) { bar.hidden = true; pop.hidden = true; return; }
  const b = els.length === 1 ? els[0] : bbox(els);
  bar.hidden = false;
  bar.style.left = (panX + (b.x + b.w / 2) * zoom) + "px";
  bar.style.top = (panY + b.y * zoom) + "px";
  if (propPopOpen) {
    pop.hidden = false;
    pop.style.left = (panX + (b.x + b.w) * zoom) + "px";
    pop.style.top = (panY + (b.y + b.h / 2) * zoom) + "px";
  } else {
    pop.hidden = true;
  }
}

const QALIGN_ICON = {
  left: `<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/>`,
  center: `<path d="M4 6h16"/><path d="M7 12h10"/><path d="M5.5 18h13"/>`,
  right: `<path d="M4 6h16"/><path d="M10 12h10"/><path d="M7 18h13"/>`,
};
/* The slim always-visible bar above the selection — quick access to the handful
 * of properties worth one click; everything else lives behind "⋯" in #proppop,
 * which is just the original #props panel relocated, unchanged. */
function renderSelToolbar() {
  const bar = $("seltoolbar");
  const els = selEls().filter((e) => !e.hidden);
  if (!els.length || editingId) { bar.innerHTML = ""; return; }
  const e = els[0];
  const one = els.length === 1;
  const t = e.type;
  const showFill = one && ["rect", "ellipse", "triangle", "star", "line", "text", "icon"].includes(t);
  const showReplace = one && t === "image";
  const showStroke = one && ["rect", "ellipse", "image", "draw"].includes(t);
  const showRadius = one && ["rect", "image"].includes(t);
  const showFlip = one && t !== "text";
  let html = "";
  if (showFill) html += `<input type="color" id="qFill" class="qcolor" title="Cor" value="${/^#[0-9a-f]{6}$/i.test(e.fill) ? e.fill : "#000000"}">`;
  if (showReplace) {
    html += `<button class="qbtn" id="qReplace" title="Substituir imagem"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 14l3-3 2.5 2.5L17 10l2 2"/><circle cx="8" cy="9" r="1.3"/></svg></button>`;
  }
  if (showStroke) {
    html += `<input type="color" id="qStroke" class="qcolor" title="Cor da borda" value="${/^#[0-9a-f]{6}$/i.test(e.stroke) ? e.stroke : "#FCFCFA"}">`;
  }
  if (showRadius) {
    html += `<button class="qbtn" id="qRadDown" title="Diminuir raio dos cantos">⌐</button>`;
    html += `<span class="qsizeval num">${Math.round(e.radius || 0)}</span>`;
    html += `<button class="qbtn" id="qRadUp" title="Aumentar raio dos cantos">◠</button>`;
  }
  if (showFlip) {
    html += `<button class="qbtn" data-qflip="h" title="Espelhar na horizontal"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7L4 12l4 5z"/><path d="M16 7l4 5-4 5z"/></svg></button>`;
    html += `<button class="qbtn" data-qflip="v" title="Espelhar na vertical"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M7 8l5-4 5 4z"/><path d="M7 16l5 4 5-4z"/></svg></button>`;
  }
  if (showReplace || showStroke || showRadius || showFlip) html += `<div class="qsep"></div>`;
  if (one && t === "text") {
    html += `<select id="qFont" class="qselect" title="Fonte">${FONTS.map((f) => `<option ${e.font === f ? "selected" : ""}>${f}</option>`).join("")}</select>`;
    html += `<div class="qsep"></div>`;
    html += `<button class="qbtn" id="qSizeDown" title="Diminuir corpo">−</button>`;
    html += `<span class="qsizeval num">${Math.round(e.size)}</span>`;
    html += `<button class="qbtn" id="qSizeUp" title="Aumentar corpo">+</button>`;
    html += `<div class="qsep"></div>`;
    html += `<button class="qbtn" data-qtw="bold" aria-pressed="${e.weight >= 700}" style="font-weight:800" title="Negrito">B</button>`;
    html += `<button class="qbtn" data-qtw="italic" aria-pressed="${!!e.italic}" style="font-style:italic" title="Itálico">I</button>`;
    html += `<button class="qbtn" data-qtw="underline" aria-pressed="${!!e.underline}" style="text-decoration:underline" title="Sublinhado">U</button>`;
    html += `<div class="qsep"></div>`;
    html += (["left", "center", "right"] as const).map((a) => `<button class="qbtn" data-qta="${a}" aria-pressed="${e.align === a}" title="Alinhar ${PT_ALIGN[a]}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${QALIGN_ICON[a]}</svg></button>`).join("");
    html += `<div class="qsep"></div>`;
  }
  html += `<button class="qbtn" id="qMore" aria-pressed="${propPopOpen}" title="Mais opções">⋯</button>`;
  bar.innerHTML = html;
}
$("seltoolbar").addEventListener("click", (ev) => {
  const tw = (ev.target as HTMLElement).closest<HTMLElement>("[data-qtw]");
  if (tw) {
    const k = tw.dataset.qtw, e = selEls()[0];
    if (k === "bold") patch({ weight: e.weight >= 700 ? 400 : 700 }, true);
    if (k === "italic") patch({ italic: !e.italic }, true);
    if (k === "underline") patch({ underline: !e.underline }, true);
    renderSelToolbar(); renderProps(); return;
  }
  const ta = (ev.target as HTMLElement).closest<HTMLElement>("[data-qta]");
  if (ta) { patch({ align: ta.dataset.qta }, true); renderSelToolbar(); renderProps(); return; }
  const qf = (ev.target as HTMLElement).closest<HTMLElement>("[data-qflip]");
  if (qf) { flip(qf.dataset.qflip); return; }
  if ((ev.target as HTMLElement).closest("#qSizeUp")) { const e = selEls()[0]; patch({ size: (e.size || 16) + 2 }, true); renderSelToolbar(); renderProps(); return; }
  if ((ev.target as HTMLElement).closest("#qSizeDown")) { const e = selEls()[0]; patch({ size: Math.max(6, (e.size || 16) - 2) }, true); renderSelToolbar(); renderProps(); return; }
  if ((ev.target as HTMLElement).closest("#qRadUp")) { const e = selEls()[0]; patch({ radius: Math.max(0, (e.radius || 0) + 4) }, true); renderSelToolbar(); renderProps(); return; }
  if ((ev.target as HTMLElement).closest("#qRadDown")) { const e = selEls()[0]; patch({ radius: Math.max(0, (e.radius || 0) - 4) }, true); renderSelToolbar(); renderProps(); return; }
  if ((ev.target as HTMLElement).closest("#qReplace")) { $("fileImgReplace").click(); return; }
  if ((ev.target as HTMLElement).closest("#qMore")) { propPopOpen = !propPopOpen; renderSelToolbar(); positionFloatingUI(); return; }
});
$("seltoolbar").addEventListener("input", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === "qFill") patch({ fill: t.value });
  if (t.id === "qFont") patch({ font: t.value }, true);
  if (t.id === "qStroke") patch({ stroke: t.value });
});
$("seltoolbar").addEventListener("change", (ev) => {
  const id = (ev.target as HTMLElement).id;
  if (id === "qFill" || id === "qStroke") commit();
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
window.addEventListener("pointerdown", (ev) => {
  const t = ev.target as HTMLElement | null;
  if (propPopOpen && t && !t.closest("#proppop") && !t.closest("#qMore")) { propPopOpen = false; positionFloatingUI(); }
}, true);



/* ============================ pointer interaction ============================ */
let drag = null;
let spaceDown = false;

$("stage").addEventListener("pointerdown", (ev) => {
  // The floating selection toolbar, its "more options" popover, the tool belt, the bottom
  // bar, and each page's own floating header/add-page button are UI chrome living inside
  // .stage — not canvas content, so a click there must never fall through to marquee-select.
  if ((ev.target as HTMLElement).closest("#seltoolbar, #proppop, #toolbelt, #flyout, #bottombar, #gridview, .pagehead, #addPageCanvas")) return;
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
  else if (!sel.includes(id)) sel = el.group ? page().els.filter((x) => x.group === el.group).map((x) => x.id) : [id];
  renderOverlay(); renderLayers(); renderProps();
  if (editingId === id) return;
  startMove(ev);
});

function startPan(ev) {
  ev.preventDefault();
  const sx = ev.clientX, sy = ev.clientY, px = panX, py = panY;
  drag = {
    move: (e) => { panX = px + (e.clientX - sx); panY = py + (e.clientY - sy); applyWorld(); updateActivePageFromScroll(); },
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
      s.innerHTML = `<path d="${pts.map((q, i) => `${i ? "L" : "M"}${q[0] - b.x},${q[1] - b.y}`).join(" ")}" fill="none" stroke="#FCFCFA" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
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

/* zoom + pan wheel */
$("stage").addEventListener("wheel", (ev) => {
  if (ev.ctrlKey || ev.metaKey) {
    ev.preventDefault();
    zoomAt(ev.clientX, ev.clientY, zoom * (1 - ev.deltaY * 0.01));
  } else {
    ev.preventDefault();
    panX -= ev.shiftKey ? ev.deltaY : ev.deltaX;
    panY -= ev.shiftKey ? 0 : ev.deltaY;
    applyWorld(); updateActivePageFromScroll();
  }
}, { passive: false });

function zoomAt(cx, cy, nz) {
  const r = $("stage").getBoundingClientRect();
  const sx = cx - r.left, sy = cy - r.top;
  const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
  zoom = clamp(nz, 0.05, 8);
  panX = sx - wx * zoom; panY = sy - wy * zoom;
  applyWorld(); updateActivePageFromScroll(); renderOverlay();
}
/** Fits page WIDTH to the viewport — height is unbounded now that pages scroll continuously,
 * Canva/Figma-style — and scrolls so the active page's top sits near the top of the view. */
/** Scrolls so page `i` is what updateActivePageFromScroll() will also call active: centred
 * if it fits the viewport, shown from its top edge if it's taller than the viewport. */
function scrollToPage(i: number) {
  const s = $("stage").getBoundingClientRect();
  const p = doc.pages[i];
  const ph = p.h * zoom;
  panY = ph <= s.height ? s.height / 2 - (pageTop(i) + p.h / 2) * zoom : -pageTop(i) * zoom + 40;
}
function zoomFit() {
  const s = $("stage").getBoundingClientRect();
  const w = stackWidth() || 800;
  zoom = clamp((s.width - 90) / w, 0.05, 8);
  panX = (s.width - w * zoom) / 2;
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
  const els = selEls().filter((e) => !e.locked);
  if (els.length < 2) return;
  const gid = uid();
  for (const e of els) e.group = gid;
  commit(); renderAll();
}
function ungroupSel() {
  const els = selEls().filter((e) => e.group);
  if (!els.length) return;
  for (const e of els) delete e.group;
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
  { id: "layers", label: "Camadas", icon: `<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>` },
];
function renderRail() {
  $("rail").innerHTML = TABS.map((t) => `
    <button class="railbtn" data-tab="${t.id}" aria-pressed="${activeTab === t.id}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
      ${t.label}
    </button>`).join("");
}
$("rail").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  activeTab = activeTab === b.dataset.tab ? null : b.dataset.tab;
  renderRail(); renderPanel();
});


/* ---------- floating toolbelt ---------- */
let beltMove = "select", beltShape = "rect";
const SV = (inner: string, fill?: boolean) => `<svg width="19" height="19" viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="${fill ? "none" : "currentColor"}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const BICON = {
  select: SV(`<path d="M5 3l14 8.4-6.1 1.3L10.9 21 5 3z"/>`, true),
  hand: SV(`<path d="M8 12.5V6.2a1.5 1.5 0 0 1 3 0V11"/><path d="M11 11V4.6a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11.4V6.4a1.5 1.5 0 0 1 3 0V14"/><path d="M17 12.2v-.7a1.5 1.5 0 0 1 3 0V15c0 3.9-2.3 6.5-6 6.5h-1.4c-2.6 0-3.6-.8-5-2.7L5.2 15.9a1.4 1.4 0 0 1 2.2-1.7L8 15"/>`),
  rect: SV(`<rect x="4" y="6" width="16" height="12" rx="2"/>`),
  ellipse: SV(`<circle cx="12" cy="12" r="8"/>`),
  triangle: SV(`<path d="M12 4.5L20 19H4z"/>`),
  star: SV(`<path d="M12 4l2.4 5.6L20 10l-4.2 3.9 1.2 6.1L12 17l-5 3 1.2-6.1L4 10l5.6-.4z"/>`),
  line: SV(`<path d="M5 19L19 5"/>`),
  pen: SV(`<path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/><path d="M13.5 7.5l3 3"/>`),
  text: SV(`<path d="M5 6h14"/><path d="M12 6v13"/>`),
  image: SV(`<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 15l4.5-4.5 3.5 3.5 3-3 6 6"/><circle cx="8.5" cy="9.5" r="1.3"/>`),
};
const SHAPES = [["rect", "Retângulo", "R"], ["ellipse", "Elipse", "O"], ["triangle", "Triângulo", ""], ["star", "Estrela", ""], ["line", "Linha", "L"]];
const MOVES = [["select", "Mover", "V"], ["hand", "Mão", "H"]];

function renderToolbelt() {
  const grp = (key, main, pressed, label, shortcut) => `
    <div class="tgroup" data-group="${key}">
      <button class="tbelt" data-belt="${key}" aria-pressed="${pressed}" title="${label}${shortcut ? " (" + shortcut + ")" : ""}">${BICON[main]}</button>
      <button class="tchev" data-chev="${key}" aria-haspopup="menu" title="Ferramentas: ${label}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 10l4 4 4-4"/></svg>
      </button>
    </div>`;
  const btn = (key, label, shortcut) => `
    <button class="tbelt" data-belt="${key}" aria-pressed="${key === "pen" && tool === "draw"}" title="${label}${shortcut ? " (" + shortcut + ")" : ""}">${BICON[key]}</button>`;

  const moveLabel = MOVES.find((m) => m[0] === beltMove)[1];
  const shapeLabel = SHAPES.find((s) => s[0] === beltShape)[1];
  $("toolbelt").innerHTML =
    grp("move", beltMove, tool === beltMove, moveLabel, MOVES.find((m) => m[0] === beltMove)[2]) +
    `<div class="tbsep"></div>` +
    grp("shape", beltShape, false, shapeLabel, SHAPES.find((s) => s[0] === beltShape)[2]) +
    btn("pen", "Caneta", "P") +
    btn("text", "Texto", "T") +
    btn("image", "Imagem", "");
}

function closeFlyout() {
  $("flyout").hidden = true;
  document.querySelectorAll(".tgroup").forEach((g) => g.removeAttribute("data-open"));
}
function openFlyout(key) {
  const group = document.querySelector(`.tgroup[data-group="${key}"]`);
  const items = key === "move" ? MOVES : SHAPES;
  const cur = key === "move" ? beltMove : beltShape;
  const f = $("flyout");
  f.innerHTML = items.map(([id, label, sc]) => `
    <button data-pick="${key}:${id}" role="menuitemradio" aria-checked="${id === cur}">
      <span style="display:grid;place-items:center;width:19px;color:var(--muted)">${BICON[id]}</span>
      ${label}<span class="tick">${sc || ""}</span>
    </button>`).join("");
  f.hidden = false;
  group.setAttribute("data-open", "true");
  const gr = group.getBoundingClientRect(), sr = $("stage").getBoundingClientRect();
  f.style.left = Math.max(8, gr.left - sr.left) + "px";
  f.style.top = (gr.top - sr.top - f.offsetHeight - 8) + "px";
}

$("toolbelt").addEventListener("click", (ev) => {
  const chev = ev.target.closest("[data-chev]");
  if (chev) {
    const key = chev.dataset.chev;
    const open = document.querySelector(`.tgroup[data-group="${key}"]`)?.hasAttribute("data-open");
    closeFlyout();
    if (!open) openFlyout(key);
    return;
  }
  const b = ev.target.closest("[data-belt]");
  if (!b) return;
  closeFlyout();
  const key = b.dataset.belt;
  if (key === "move") return setTool(beltMove);
  if (key === "pen") return setTool(tool === "draw" ? "select" : "draw");
  if (key === "shape") { setTool("select"); return addEl(beltShape); }
  if (key === "text") { setTool("select"); return addEl("text"); }
  if (key === "image") return $("fileImg").click();
});
$("flyout").addEventListener("click", (ev) => {
  const p = ev.target.closest("[data-pick]");
  if (!p) return;
  const [key, id] = p.dataset.pick.split(":");
  closeFlyout();
  if (key === "move") { beltMove = id; setTool(id); }
  else { beltShape = id; renderToolbelt(); setTool("select"); addEl(id); }
});
window.addEventListener("pointerdown", (ev) => {
  const t = ev.target as HTMLElement | null;
  if (t && !t.closest("#flyout") && !t.closest(".tchev")) closeFlyout();
}, true);

function renderPanel() {
  const el = $("panel");
  if (!activeTab) { el.hidden = true; return; }
  el.hidden = false;
  const P = page();
  if (activeTab === "text") {
    el.innerHTML = `<h4 class="ptitle">Texto</h4><p class="phint">Clique para adicionar. Dê duplo clique em qualquer texto da tela para editá-lo no lugar.</p>
      <button class="texttile" data-add="text" data-size="88" data-weight="700" style="font-size:21px;font-weight:700">Título</button>
      <button class="texttile" data-add="text" data-size="52" data-weight="600" style="font-size:16px;font-weight:600">Subtítulo</button>
      <button class="texttile" data-add="text" data-size="30" data-weight="400" style="font-size:13px">Corpo de texto</button>`;
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
        <button class="tile" data-add="${t}"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">${ic}</svg>${n}</button>`).join("")}</div>`;
  }
  if (activeTab === "uploads") {
    el.innerHTML = `<h4 class="ptitle">Imagens</h4><p class="phint">Suas próprias imagens, deste dispositivo. Ficam guardadas dentro do design.</p>
      <button class="dropzone" id="pickImg">Escolher imagens…</button>
      <p class="phint">Nada aqui vem de banco de imagens.</p>`;
  }
  if (activeTab === "draw") {
    el.innerHTML = `<h4 class="ptitle">Desenho</h4><p class="phint">Caneta à mão livre. Cada traço vira uma camada editável.</p>
      <button class="tile" style="width:100%;height:44px;flex-direction:row;gap:8px" id="drawOn" aria-pressed="${tool === "draw"}">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/></svg>
        ${tool === "draw" ? "Desenhando — clique para parar" : "Começar a desenhar"}</button>`;
  }
  if (activeTab === "page") {
    el.innerHTML = `<h4 class="ptitle">Tela</h4><p class="phint">Cor de fundo e tamanho da tela na página ${doc.active + 1}.</p>
      <div class="sec"><h4>Fundo</h4>
        <div class="grid4" style="margin-bottom:8px">${PALETTE.slice(0, 8).map((c) => `<button class="swatch" data-bg="${c}" aria-pressed="${P.bg.toLowerCase() === c}" style="background:${c}"></button>`).join("")}</div>
        <div class="field"><label>Hex</label><input type="color" id="bgPick" value="${P.bg}"></div>
      </div>
      <div class="sec"><h4>Fundo do canvas</h4><p class="phint" style="margin-bottom:8px">A área ao redor da página — não o conteúdo dela.</p>
        <div class="grid4" style="margin-bottom:8px">${STAGE_BG_PRESETS.map((c) => `<button class="swatch" data-stagebg="${c}" aria-pressed="${stageBg.toLowerCase() === c}" style="background:${c}"></button>`).join("")}</div>
        <div class="field"><label>Hex</label><input type="color" id="stageBgPick" value="${stageBg}"></div>
      </div>
      <div class="sec"><h4>Tamanho</h4><p class="phint" style="margin-bottom:8px">Aplica a todas as páginas do documento.</p>
        <div class="grid2" style="margin-bottom:8px">${PAGE_SIZES.map((s) => `<button class="tile" style="height:46px;font-size:10px" data-size="${s.w}x${s.h}">${s.n}<span class="num" style="color:var(--faint)">${s.w}×${s.h}</span></button>`).join("")}</div>
        <div class="row"><div class="field"><label>L</label><input class="num" id="pgW" value="${P.w}"></div><div class="field"><label>A</label><input class="num" id="pgH" value="${P.h}"></div></div>
      </div>`;
  }
  if (activeTab === "layers") renderLayers();
}

function renderLayers() {
  if (activeTab !== "layers") return;
  const P = page();
  const icons = {
    rect: `<rect x="4" y="6" width="16" height="12" rx="1.5"/>`, ellipse: `<circle cx="12" cy="12" r="8"/>`,
    triangle: `<polygon points="12,4 20,19 4,19"/>`, star: `<polygon points="12,4 14,9.6 20,10 15.5,13.8 17,19.6 12,16.4 7,19.6 8.5,13.8 4,10 10,9.6"/>`,
    line: `<rect x="4" y="11" width="16" height="2" rx="1"/>`, text: `<path d="M4 6h16"/><path d="M12 6v14"/>`,
    image: `<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 15.5l5-5 4 4 3.5-3.5 4.5 4.5"/>`,
    draw: `<path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/>`,
    icon: `<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>`,
  };
  $("panel").innerHTML = `<h4 class="ptitle">Camadas</h4><p class="phint">O topo da lista é a frente da tela.</p>` +
    (P.els.length ? [...P.els].reverse().map((e) => `
      <div class="layer" data-layer="${e.id}" aria-selected="${sel.includes(e.id)}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:.65">${icons[e.type] || ""}</svg>
        <span class="lname">${esc(e.name)}</span>
        <button class="mini" data-lock="${e.id}" title="${e.locked ? "Desbloquear" : "Bloquear"}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${e.locked ? `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>` : `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>`}</svg>
        </button>
        <button class="mini" data-hide="${e.id}" title="${e.hidden ? "Mostrar" : "Ocultar"}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${e.hidden ? `<path d="M3 3l18 18"/><path d="M10.6 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.4 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.3 0 2.5-.3 3.6-.7"/>` : `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.6"/>`}</svg>
        </button>
      </div>`).join("") : `<p class="empty">Esta página está vazia. Adicione texto ou uma forma pela barra lateral.</p>`);
}

$("panel").addEventListener("click", (ev) => {
  const add = ev.target.closest("[data-add]");
  if (add) {
    const t = add.dataset.add;
    const over: Partial<El> = {};
    if (add.dataset.size) over.size = +add.dataset.size;
    if (add.dataset.weight) over.weight = +add.dataset.weight;
    if (t === "text") over.text = add.textContent.trim();
    addEl(t, over);
    return;
  }
  const bg = ev.target.closest("[data-bg]");
  if (bg) { page().bg = bg.dataset.bg; commit(); renderAll(); return; }
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
  const lock = ev.target.closest("[data-lock]");
  if (lock) { const e = byId(lock.dataset.lock); e.locked = !e.locked; commit(); renderAll(); return; }
  const hide = ev.target.closest("[data-hide]");
  if (hide) { const e = byId(hide.dataset.hide); e.hidden = !e.hidden; commit(); renderAll(); return; }
  const layer = ev.target.closest("[data-layer]");
  if (layer) {
    const id = layer.dataset.layer;
    sel = ev.shiftKey ? (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]) : [id];
    renderAll();
  }
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
  const box = $("props");
  const els = selEls();
  if (!els.length) {
    box.innerHTML = "";
    return;
  }
  const e = els[0];
  const one = els.length === 1;
  const t = e.type;
  const shows = { fill: ["rect", "ellipse", "triangle", "star", "line", "text", "icon"].includes(t), stroke: ["rect", "ellipse", "image", "draw"].includes(t), radius: ["rect", "image"].includes(t) };

  box.innerHTML = `
    ${one ? `<div class="sec"><h4>Camada</h4><div class="field"><input id="pName" value="${esc(e.name)}" style="font-family:var(--body)"></div></div>` : `<div class="sec"><h4>${els.length} objetos selecionados</h4></div>`}

    <div class="sec"><h4>Organizar</h4>
      <div class="seg" style="margin-bottom:6px">
        ${[["front", "Trazer para a frente", `<rect x="4" y="4" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/><rect x="8" y="8" width="12" height="12" rx="1.5"/>`],
           ["up", "Avançar", `<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>`],
           ["down", "Recuar", `<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>`],
           ["back", "Enviar para trás", `<rect x="8" y="8" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/><rect x="4" y="4" width="12" height="12" rx="1.5"/>`]]
          .map(([k, tip, ic]) => `<button data-order="${k}" title="${tip}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ic}</svg></button>`).join("")}
      </div>
      <div class="seg" style="margin-bottom:6px">
        ${[["left", "M5 4v16M9 8h10v3H9zM9 15h6v3H9z"], ["cx", "M12 4v16M7 8h10v3H7zM9 15h6v3H9z"], ["right", "M19 4v16M5 8h10v3H5zM9 15h6v3H9z"]]
          .map(([k, d]) => `<button data-align="${k}" title="Alinhar ${PT_ALIGN[k]}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${d}"/></svg></button>`).join("")}
        ${[["top", "M4 5h16M8 9h3v10H8zM15 9h3v6h-3z"], ["cy", "M4 12h16M8 5h3v14H8zM15 8h3v8h-3z"], ["bottom", "M4 19h16M8 5h3v10H8zM15 9h3v6h-3z"]]
          .map(([k, d]) => `<button data-align="${k}" title="Alinhar ${PT_ALIGN[k]}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${d}"/></svg></button>`).join("")}
      </div>
      <div class="seg">
        <button data-flip="h" title="Espelhar na horizontal"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7L4 12l4 5z"/><path d="M16 7l4 5-4 5z"/></svg></button>
        <button data-flip="v" title="Espelhar na vertical"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M7 8l5-4 5 4z"/><path d="M7 16l5 4 5-4z"/></svg></button>
        <button data-cmd="duplicate" title="Duplicar (⌘D)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="3" width="13" height="13" rx="1.5"/><rect x="8" y="8" width="13" height="13" rx="1.5"/></svg></button>
        <button data-cmd="delete" title="Excluir (⌫)" style="color:var(--danger)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/></svg></button>
      </div>
    </div>

    ${one ? `<div class="sec"><h4>Posição e tamanho</h4>
      <div class="grid2" style="gap:6px">
        <div class="field"><label>X</label><input id="pX" value="${Math.round(e.x)}"></div>
        <div class="field"><label>Y</label><input id="pY" value="${Math.round(e.y)}"></div>
        <div class="field"><label>L</label><input id="pW" value="${Math.round(e.w)}"></div>
        <div class="field"><label>A</label><input id="pH" value="${Math.round(e.h)}" ${t === "text" ? "disabled" : ""}></div>
        <div class="field"><label>∠</label><input id="pR" value="${Math.round(e.rot)}"></div>
      </div></div>` : ""}

    ${shows.fill ? `<div class="sec"><h4>${t === "text" ? "Cor do texto" : "Preenchimento"}</h4>
      <div class="grid4" style="margin-bottom:7px">${PALETTE.map((c) => `<button class="swatch" style="height:26px;background:${c}" data-fill="${c}" aria-pressed="${(e.fill || "").toLowerCase() === c}"></button>`).join("")}</div>
      <div class="field"><input type="color" id="pFill" value="${/^#[0-9a-f]{6}$/i.test(e.fill) ? e.fill : "#000000"}"></div></div>` : ""}

    ${t === "text" ? `<div class="sec"><h4>Tipografia</h4>
      <select class="field" id="pFont" style="width:100%;margin-bottom:6px">${FONTS.map((f) => `<option ${e.font === f ? "selected" : ""}>${f}</option>`).join("")}</select>
      <div class="row" style="margin-bottom:6px">
        <div class="field" style="flex:1"><label>Corpo</label><input id="pSize" value="${e.size}"></div>
        <div class="field" style="flex:1"><label>Entrelinha</label><input id="pLh" value="${e.lh}"></div>
      </div>
      <div class="field" style="margin-bottom:6px"><label>Espaçamento</label><input id="pLs" value="${e.ls}"></div>
      <div class="seg" style="margin-bottom:6px">
        <button data-tw="bold" aria-pressed="${e.weight >= 700}" style="font-weight:800">B</button>
        <button data-tw="italic" aria-pressed="${!!e.italic}" style="font-style:italic;font-family:Lora,serif">I</button>
        <button data-tw="underline" aria-pressed="${!!e.underline}" style="text-decoration:underline">U</button>
      </div>
      <div class="seg">${["left", "center", "right"].map((a) => `<button data-ta="${a}" aria-pressed="${e.align === a}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16"/><path d="${a === "left" ? "M4 12h10" : a === "center" ? "M7 12h10" : "M10 12h10"}"/><path d="${a === "left" ? "M4 18h13" : a === "center" ? "M5.5 18h13" : "M7 18h13"}"/></svg></button>`).join("")}</div>
    </div>` : ""}

    ${shows.stroke ? `<div class="sec"><h4>${t === "draw" ? "Traço" : "Borda"}</h4>
      <div class="row"><div class="field" style="flex:0 0 54px"><input type="color" id="pStroke" value="${/^#[0-9a-f]{6}$/i.test(e.stroke) ? e.stroke : "#FCFCFA"}"></div>
      <div class="field" style="flex:1"><label>Espessura</label><input id="pSW" value="${e.strokeWidth || 0}"></div></div></div>` : ""}

    ${shows.radius ? `<div class="sec"><h4>Raio dos cantos</h4><div class="field" style="width:96px"><input id="pRad" value="${e.radius || 0}"></div></div>` : ""}

    <div class="sec"><h4>Opacidade</h4>
      <div class="row"><input type="range" id="pOp" min="0" max="100" value="${Math.round((e.opacity ?? 1) * 100)}">
      <span class="num" style="width:38px;text-align:right;color:var(--muted)">${Math.round((e.opacity ?? 1) * 100)}%</span></div>
    </div>`;
}

$("props").addEventListener("click", (ev) => {
  const g = (a) => ev.target.closest(`[data-${a}]`);
  if (g("order")) return order(g("order").dataset.order);
  if (g("align")) return align(g("align").dataset.align);
  if (g("flip")) return flip(g("flip").dataset.flip);
  if (g("cmd")) return g("cmd").dataset.cmd === "delete" ? deleteSel() : duplicateSel();
  if (g("fill")) return patch({ fill: g("fill").dataset.fill }, true), renderProps();
  if (g("tw")) {
    const k = g("tw").dataset.tw, e = selEls()[0];
    if (k === "bold") patch({ weight: e.weight >= 700 ? 400 : 700 }, true);
    if (k === "italic") patch({ italic: !e.italic }, true);
    if (k === "underline") patch({ underline: !e.underline }, true);
    return renderProps();
  }
  if (g("ta")) return patch({ align: g("ta").dataset.ta }, true), renderProps();
});
$("props").addEventListener("input", (ev) => {
  const id = ev.target.id, v = ev.target.value, n = parseFloat(v);
  const map = {
    pX: () => patch({ x: n || 0 }), pY: () => patch({ y: n || 0 }),
    pW: () => n > 0 && patch({ w: n }), pH: () => n > 0 && patch({ h: n }),
    pR: () => patch({ rot: n || 0 }), pName: () => patch({ name: v }),
    pFill: () => patch({ fill: v }),
    pFont: () => patch({ font: v }), pSize: () => n > 0 && patch({ size: n }),
    pLh: () => n > 0 && patch({ lh: n }), pLs: () => patch({ ls: n || 0 }),
    pStroke: () => patch({ stroke: v }), pSW: () => patch({ strokeWidth: Math.max(0, n || 0) }),
    pRad: () => patch({ radius: Math.max(0, n || 0) }),
    pOp: () => patch({ opacity: clamp(n / 100, 0, 1) }),
  };
  if (map[id]) { map[id](); if (id === "pOp") ev.target.nextElementSibling.textContent = Math.round(n) + "%"; }
  if (["pW", "pH", "pR", "pSize"].includes(id)) renderOverlay();
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
      const c = await renderPageCanvas(p, Math.min(0.2, 150 / p.w));
      thumbs.set(p.id, c.toDataURL("image/jpeg", 0.72));
      if (!$("gridview").hidden) renderGridView();
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
  <button class="pmini" data-${action}="${i}" title="${title}" ${disabled ? "disabled" : ""}>
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
  </button>`;

// Page management (move/hide/duplicate/delete/add) lives directly on the main canvas — each
// page's own floating header, rendered in renderCanvas() — not in a separate side panel.
$("pagestack").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#addPageCanvas")) {
    const last = doc.pages[doc.pages.length - 1];
    const p = blankPage(); p.w = last.w; p.h = last.h;
    doc.pages.push(p); doc.active = doc.pages.length - 1; sel = [];
    commit(); renderAll();
    scrollToPage(doc.active); applyWorld();
    return;
  }
  const dup = t.closest<HTMLElement>("[data-duppage]");
  if (dup) {
    const i = +dup.dataset.duppage;
    const copy = structuredClone(doc.pages[i]);
    copy.id = uid();
    copy.els.forEach((e) => { e.id = uid(); });
    doc.pages.splice(i + 1, 0, copy);
    doc.active = i + 1; sel = [];
    commit(); renderAll(); buildThumbs();
    return;
  }
  const del = t.closest<HTMLElement>("[data-delpage]");
  if (del) {
    doc.pages.splice(+del.dataset.delpage, 1);
    doc.active = clamp(doc.active, 0, doc.pages.length - 1); sel = [];
    commit(); renderAll(); return;
  }
  const up = t.closest<HTMLElement>("[data-moveuppage]");
  if (up) {
    const i = +up.dataset.moveuppage;
    if (i > 0) {
      [doc.pages[i - 1], doc.pages[i]] = [doc.pages[i], doc.pages[i - 1]];
      if (doc.active === i) doc.active = i - 1; else if (doc.active === i - 1) doc.active = i;
      commit(); renderCanvas();
    }
    return;
  }
  const down = t.closest<HTMLElement>("[data-movedownpage]");
  if (down) {
    const i = +down.dataset.movedownpage;
    if (i < doc.pages.length - 1) {
      [doc.pages[i], doc.pages[i + 1]] = [doc.pages[i + 1], doc.pages[i]];
      if (doc.active === i) doc.active = i + 1; else if (doc.active === i + 1) doc.active = i;
      commit(); renderCanvas();
    }
    return;
  }
  const hide = t.closest<HTMLElement>("[data-hidepage]");
  if (hide) {
    const i = +hide.dataset.hidepage;
    doc.pages[i].hidden = !doc.pages[i].hidden;
    commit(); renderCanvas();
    return;
  }
});

/* ---------- grid view ---------- */
function renderGridView() {
  $("gridview").innerHTML = doc.pages.map((p, i) => `
    <div class="gridcell" data-gridpage="${i}" aria-selected="${i === doc.active}">
      <div class="pt" style="background:${p.bg}; aspect-ratio:${p.w}/${p.h}; opacity:${p.hidden ? .45 : 1}">${thumbs.has(p.id)
        ? `<img src="${thumbs.get(p.id)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
        : ""}</div>
      <span class="plabel">Página ${i + 1}${p.hidden ? " · oculta" : ""}</span>
    </div>`).join("");
}
$("gridViewBtn").addEventListener("click", () => { renderGridView(); $("gridview").hidden = false; });
$("gridview").addEventListener("click", (ev) => {
  const cell = (ev.target as HTMLElement).closest<HTMLElement>("[data-gridpage]");
  if (!cell) { $("gridview").hidden = true; return; }
  doc.active = +cell.dataset.gridpage; sel = []; editingId = null;
  baseline = snap();
  $("gridview").hidden = true;
  renderAll(); zoomFit();
});
$("pageCountBtn").addEventListener("click", () => { renderGridView(); $("gridview").hidden = false; });

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
    `<button class="fmt" data-fmt="${f}" aria-pressed="${expFmt === f}">${f.toUpperCase()}</button>`).join("");
  $("scales").innerHTML = [1, 2, 3].map((s) =>
    `<button data-scale="${s}" aria-pressed="${expScale === s}">${s}×</button>`).join("");
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
$("resizeBtn").addEventListener("click", () => { activeTab = "page"; renderRail(); renderPanel(); });
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
  if (t === "select" || t === "hand") beltMove = t;
  $("stage").style.cursor = t === "hand" ? "grab" : t === "draw" ? "crosshair" : "default";
  renderToolbelt();
  if (activeTab === "draw") renderPanel();
}
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
  if (e.key === "Escape" && !$("gridview").hidden) { $("gridview").hidden = true; return; }
  if (e.code === "Space" && !typing()) { spaceDown = true; $("stage").style.cursor = "grab"; }
  if (typing()) { if (e.key === "Escape") (document.activeElement as HTMLElement).blur(); return; }
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
  if (mod && e.key === "]") { e.preventDefault(); order("up"); return; }
  if (mod && e.key === "[") { e.preventDefault(); order("down"); return; }
  if (e.key === "Delete" || e.key === "Backspace") { if (sel.length) { e.preventDefault(); deleteSel(); } return; }
  if (e.key === "Escape") { sel = []; editingId = null; setTool("select"); renderAll(); return; }
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
  renderRail(); renderToolbelt(); renderPanel(); renderAll(); buildThumbs(); syncHistory();
  requestAnimationFrame(zoomFit);
  document.fonts.ready.then(() => renderCanvas());
  window.addEventListener("resize", () => { if (editorMounted) applyWorld(); });
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
