import "./styles.css";
import SEED_JSON from "./seed.json";
import { b64ToBytes, buildPDF } from "./pdf";
import type { Doc, El, Page } from "./types";
import { createTweetTemplateDocument, TWEET_TEMPLATE_ID } from "./tweetTemplateDoc";
import { fetchTemplateFromServer, loadTemplateLocally, saveTemplateLocally, syncTemplateToServer } from "./templateStore";

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
  { n: "Post", w: 1080, h: 1080 }, { n: "Story", w: 1080, h: 1920 },
  { n: "Slide", w: 1920, h: 1080 }, { n: "A4", w: 794, h: 1123 },
  { n: "Capa", w: 1200, h: 630 }, { n: "Cartão", w: 1050, h: 600 },
];
const TYPE_PT = { rect: "Retângulo", ellipse: "Elipse", triangle: "Triângulo", star: "Estrela", line: "Linha", text: "Texto", image: "Imagem", icon: "Ícone", draw: "Desenho" };
const PT_ALIGN = { left: "à esquerda", cx: "ao centro", right: "à direita", top: "ao topo", cy: "ao meio", bottom: "à base" };
const PALETTE = ["#FCFCFA", "#E3E2DE", "#C4C2BC", "#9B9992", "#6E6C67", "#4A4944", "#2E2D29", "#111111"];

/* ============================ state ============================ */
const blankPage = () => ({ id: uid(), w: 1080, h: 1080, bg: "#111111", els: [] });
function seedDoc() {
  try {
    return structuredClone(SEED_JSON) as unknown as Doc;
  } catch (e) { /* fall through to a blank document */ }
  return { name: "Design sem título", pages: [blankPage()], active: 0 } as Doc;
}
const SEED: Doc = seedDoc();
let doc: Doc = SEED;
let sel: string[] = [];
let tool = "select";
let zoom = 1, panX = 0, panY = 0;
let past: string[] = [], future: string[] = [];
let clipboard = null;
let editingId = null;
let activeTab = "elements";
const imgCache = new Map<string, HTMLImageElement>();

const page = (): Page => doc.pages[doc.active];
const byId = (id: string): El | undefined => page().els.find((e) => e.id === id);
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
  doc = o.d; sel = o.s.filter((id) => o.d.pages[o.d.active]?.els.some((e) => e.id === id));
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
function syncHistory() { /* undo/redo are keyboard-only, Figma-style — nothing to sync */ }

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
    doc = o; doc.active = clamp(doc.active | 0, 0, doc.pages.length - 1);
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
function toPage(ev: { clientX: number; clientY: number }) {
  const r = $("pagebox").getBoundingClientRect();
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

function renderCanvas() {
  const p = page();
  const box = $("pagebox");
  box.style.width = p.w + "px";
  box.style.height = p.h + "px";
  box.style.background = p.bg;
  box.innerHTML = p.els
    .map((e) => `<div class="el${e.locked ? " locked" : ""}" data-id="${e.id}" style="${elStyle(e)}">${elInner(e)}</div>`)
    .join("");
  // text auto-height
  for (const e of p.els) {
    if (e.type !== "text") continue;
    const node = box.querySelector(`[data-txt="${e.id}"]`);
    if (node) {
      const h = Math.max(20, Math.ceil(node.scrollHeight));
      if (Math.abs(h - e.h) > 1) { e.h = h; node.parentElement.style.height = h + "px"; }
    }
  }
  applyWorld();
  renderOverlay();
}

function applyWorld() {
  $("world").style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  $("ovl").style.setProperty("--inv", 1 / zoom);
  $("pagebox").parentElement.style.setProperty("--inv", 1 / zoom);
  $("zoomval").textContent = Math.round(zoom * 100) + "%";
  const o = $("ovl");
  o.style.width = page().w + "px";
  o.style.height = page().h + "px";
}

const HANDLES: Array<[string, number, number]> = [["nw", 0, 0], ["n", .5, 0], ["ne", 1, 0], ["e", 1, .5], ["se", 1, 1], ["s", .5, 1], ["sw", 0, 1], ["w", 0, .5]];
const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

function renderOverlay() {
  const o = $("ovl");
  const els = selEls().filter((e) => !e.hidden);
  if (!els.length || editingId) { o.innerHTML = ""; return; }
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
}



/* ============================ pointer interaction ============================ */
let drag = null;
let spaceDown = false;

$("stage").addEventListener("pointerdown", (ev) => {
  if (ev.button === 1 || spaceDown || tool === "hand") { startPan(ev); return; }
  const hdl = ev.target.closest(".hdl");
  if (hdl) { startTransform(ev, hdl); return; }
  const node = ev.target.closest(".el");

  if (tool === "draw") { startDraw(ev); return; }

  if (!node) {
    if (editingId) stopEditing();
    startMarquee(ev);
    return;
  }
  const id = node.dataset.id;
  const el = byId(id);
  if (!el || el.hidden) return;
  if (editingId && editingId !== id) stopEditing();
  if (el.locked) { sel = [id]; renderAll(); return; }

  if (ev.shiftKey) sel = sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id];
  else if (!sel.includes(id)) sel = [id];
  renderOverlay(); renderLayers(); renderProps();
  if (editingId === id) return;
  startMove(ev);
});

function startPan(ev) {
  ev.preventDefault();
  const sx = ev.clientX, sy = ev.clientY, px = panX, py = panY;
  drag = {
    move: (e) => { panX = px + (e.clientX - sx); panY = py + (e.clientY - sy); applyWorld(); },
    up: () => {},
  };
  capture(ev);
}

function startMove(ev) {
  const start = toPage(ev);
  const els = selEls().filter((e) => !e.locked);
  if (!els.length) return;
  const orig = els.map((e) => ({ e, x: e.x, y: e.y }));
  let moved = false;
  drag = {
    move: (e) => {
      const p = toPage(e);
      let dx = p.x - start.x, dy = p.y - start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5) moved = true;
      for (const o of orig) { o.e.x = Math.round(o.x + dx); o.e.y = Math.round(o.y + dy); }
      const g = snapMove(els, e.altKey);
      for (const o of orig) { o.e.x += g.dx; o.e.y += g.dy; }
      renderCanvas(); drawGuides(g.guides);
      moved && renderProps();
    },
    up: () => { clearGuides(); if (moved) commit(); },
  };
  capture(ev);
}

function snapMove(els, off) {
  if (off) return { dx: 0, dy: 0, guides: [] };
  const p = page(), b = bbox(els), T = 6 / zoom, guides = [];
  const others = p.els.filter((e) => !els.includes(e) && !e.hidden);
  const xt = [p.w / 2, 0, p.w], yt = [p.h / 2, 0, p.h];
  for (const o of others) { xt.push(o.x, o.x + o.w / 2, o.x + o.w); yt.push(o.y, o.y + o.h / 2, o.y + o.h); }
  let dx = 0, dy = 0, bx = T, by = T, gx = null, gy = null;
  for (const t of xt) for (const v of [b.x, b.x + b.w / 2, b.x + b.w]) {
    const d = t - v; if (Math.abs(d) < bx) { bx = Math.abs(d); dx = d; gx = t; }
  }
  for (const t of yt) for (const v of [b.y, b.y + b.h / 2, b.y + b.h]) {
    const d = t - v; if (Math.abs(d) < by) { by = Math.abs(d); dy = d; gy = t; }
  }
  if (gx !== null) guides.push({ v: 1, at: gx });
  if (gy !== null) guides.push({ v: 0, at: gy });
  return { dx: Math.round(dx), dy: Math.round(dy), guides };
}
function drawGuides(gs) {
  clearGuides();
  const o = $("ovl");
  for (const g of gs) {
    const d = document.createElement("div");
    d.className = "guide";
    if (g.v) { d.style.cssText = `left:${g.at}px;top:0;width:1px;height:${page().h}px`; }
    else { d.style.cssText = `top:${g.at}px;left:0;height:1px;width:${page().w}px`; }
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
  const start = toPage(ev);

  if (kind === "rot") {
    const e = els[0];
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
    const a0 = Math.atan2(start.y - cy, start.x - cx) * 180 / Math.PI;
    const r0 = e.rot;
    drag = {
      move: (m) => {
        const p = toPage(m);
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
        const p = toPage(m);
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
      const p = toPage(m);
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
  const start = toPage(ev);
  const box = document.createElement("div");
  box.className = "marquee";
  $("ovl").appendChild(box);
  if (!ev.shiftKey) { sel = []; renderOverlay(); renderLayers(); renderProps(); }
  const base = [...sel];
  drag = {
    move: (m) => {
      const p = toPage(m);
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
      const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
      box.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      const hit = page().els.filter((e) => !e.hidden && e.x < x + w && e.x + e.w > x && e.y < y + h && e.y + e.h > y).map((e) => e.id);
      sel = [...new Set([...base, ...hit])];
      renderLayers();
    },
    up: () => { box.remove(); renderOverlay(); renderProps(); },
  };
  capture(ev);
}

function startDraw(ev) {
  const start = toPage(ev);
  const pts = [[start.x, start.y]];
  drag = {
    move: (m) => {
      const p = toPage(m);
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
      addEl("draw", {
        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h),
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
$("stage").addEventListener("dblclick", (ev) => {
  const node = ev.target.closest(".el");
  if (!node) return;
  const el = byId(node.dataset.id);
  if (!el || el.type !== "text" || el.locked) return;
  editingId = el.id;
  renderOverlay();
  const t = node.querySelector(".txt");
  t.setAttribute("contenteditable", "true");
  t.focus();
  document.getSelection().selectAllChildren(t);
  t.addEventListener("blur", stopEditing, { once: true });
});
function stopEditing() {
  if (!editingId) return;
  const t = $("pagebox").querySelector(`[data-txt="${editingId}"]`);
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
    applyWorld();
  }
}, { passive: false });

function zoomAt(cx, cy, nz) {
  const r = $("stage").getBoundingClientRect();
  const sx = cx - r.left, sy = cy - r.top;
  const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
  zoom = clamp(nz, 0.05, 8);
  panX = sx - wx * zoom; panY = sy - wy * zoom;
  applyWorld(); renderOverlay();
}
function zoomFit() {
  const s = $("stage").getBoundingClientRect(), p = page();
  zoom = clamp(Math.min((s.width - 90) / p.w, (s.height - 90) / p.h), 0.05, 8);
  panX = (s.width - p.w * zoom) / 2;
  panY = (s.height - p.h * zoom) / 2;
  applyWorld(); renderOverlay();
}



/* ============================ commands ============================ */
function deleteSel() {
  const locked = selEls().some((e) => e.locked);
  const p = page();
  p.els = p.els.filter((e) => !sel.includes(e.id) || e.locked);
  if (!locked) sel = [];
  commit(); renderAll();
}
function duplicateSel() {
  const els = selEls();
  if (!els.length) return;
  const copies = els.map((e) => ({ ...structuredClone(e), id: uid(), x: e.x + 24, y: e.y + 24 }));
  page().els.push(...copies);
  sel = copies.map((c) => c.id);
  commit(); renderAll();
}
function copySel() {
  const els = selEls();
  if (els.length) { clipboard = structuredClone(els); toast(`${els.length} copiado(s)`); }
}
function paste() {
  if (!clipboard?.length) return;
  const copies = clipboard.map((e) => ({ ...structuredClone(e), id: uid(), x: e.x + 30, y: e.y + 30 }));
  page().els.push(...copies);
  sel = copies.map((c) => c.id);
  commit(); renderAll();
}
function order(dir) {
  const p = page();
  const idx = sel.map((id) => p.els.findIndex((e) => e.id === id)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (!idx.length) return;
  if (dir === "front") { const m = idx.map((i) => p.els[i]); for (const e of m) { p.els.splice(p.els.indexOf(e), 1); p.els.push(e); } }
  if (dir === "back") { const m = idx.map((i) => p.els[i]); for (const e of [...m].reverse()) { p.els.splice(p.els.indexOf(e), 1); p.els.unshift(e); } }
  if (dir === "up") for (const i of [...idx].reverse()) { if (i < p.els.length - 1) { [p.els[i], p.els[i + 1]] = [p.els[i + 1], p.els[i]]; } }
  if (dir === "down") for (const i of idx) { if (i > 0) { [p.els[i], p.els[i - 1]] = [p.els[i - 1], p.els[i]]; } }
  commit(); renderAll();
}
function align(how) {
  const els = selEls().filter((e) => !e.locked);
  if (!els.length) return;
  const p = page();
  const b = els.length > 1 ? bbox(els) : { x: 0, y: 0, w: p.w, h: p.h };
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
  { id: "pages", label: "Páginas", icon: `<rect x="4" y="3" width="12" height="16" rx="1.5"/><path d="M8 21h10a2 2 0 0 0 2-2V8"/>` },
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
      <div class="sec"><h4>Tamanho</h4>
        <div class="grid2" style="margin-bottom:8px">${PAGE_SIZES.map((s) => `<button class="tile" style="height:46px;font-size:10px" data-size="${s.w}x${s.h}">${s.n}<span class="num" style="color:var(--faint)">${s.w}×${s.h}</span></button>`).join("")}</div>
        <div class="row"><div class="field"><label>L</label><input class="num" id="pgW" value="${P.w}"></div><div class="field"><label>A</label><input class="num" id="pgH" value="${P.h}"></div></div>
      </div>`;
  }
  if (activeTab === "pages") renderPages();
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
  const sz = ev.target.closest("[data-size]:not([data-add])");
  if (sz) {
    const [w, h] = sz.dataset.size.split("x").map(Number);
    page().w = w; page().h = h; commit(); renderAll(); zoomFit(); return;
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
  if (ev.target.id === "pgW" || ev.target.id === "pgH") {
    const w = +$("pgW").value, h = +$("pgH").value;
    if (w > 20 && h > 20) { page().w = w; page().h = h; renderCanvas(); }
  }
});
$("panel").addEventListener("change", (ev) => {
  if (["bgPick", "pgW", "pgH"].includes(ev.target.id)) commit();
});


/* ============================ properties ============================ */
function renderProps() {
  const box = $("props");
  const els = selEls();
  if (!els.length) {
    box.innerHTML = `<div class="sec"><h4>Nada selecionado</h4>
      <p class="empty">Clique em um objeto para editá-lo. Arraste na área vazia para selecionar por retângulo, ou segure <b>Shift</b> para somar à seleção.</p></div>
      <div class="sec"><h4>Página ${doc.active + 1} de ${doc.pages.length}</h4>
      <p class="empty num">${page().w} × ${page().h} px</p></div>`;
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
      <div class="field"><input type="color" id="pFill" value="${/^#[0-9a-f]{6}$/i.test(e.fill) ? e.fill : "#000000"}"><input class="num" id="pFillHex" value="${e.fill}"></div></div>` : ""}

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
    pFill: () => patch({ fill: v }), pFillHex: () => /^#[0-9a-f]{3,8}$/i.test(v) && patch({ fill: v }),
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
      if (activeTab === "pages") renderPages();
    }
  } catch (e) { /* a thumbnail is a nicety, never a blocker */ }
  thumbBusy = false;
}
const dirtyThumb = (id?: string) => { thumbs.delete(id || page().id); buildThumbs(); };

function renderPages() {
  if (activeTab !== "pages") return;
  $("panel").innerHTML = `<h4 class="ptitle">Páginas</h4><p class="phint">Cada página exporta como imagem própria; o PDF leva todas.</p>
    <div class="pages" id="pages">` + doc.pages.map((p, i) => `
      <div class="pagethumb" data-page="${i}" aria-selected="${i === doc.active}">
        <div class="pt" style="background:${p.bg}">${thumbs.has(p.id)
          ? `<img src="${thumbs.get(p.id)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
          : ""}</div>
        <span class="plabel">Página ${i + 1}</span>
        <button class="pdup" data-duppage="${i}" title="Duplicar página"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><rect x="3" y="3" width="13" height="13" rx="2"/><rect x="8" y="8" width="13" height="13" rx="2"/></svg></button>
        ${doc.pages.length > 1 ? `<button class="pdel" data-delpage="${i}" title="Excluir página"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>` : ""}
      </div>`).join("") +
    `<button class="addpage" id="addPage" title="Adicionar página"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></div>`;
}
$("panel").addEventListener("click", (ev) => {
  if (ev.target.closest("#addPage")) {
    const p = blankPage(); p.w = page().w; p.h = page().h;
    doc.pages.push(p); doc.active = doc.pages.length - 1; sel = [];
    commit(); renderAll(); zoomFit(); return;
  }
  const dup = ev.target.closest("[data-duppage]");
  if (dup) {
    const i = +dup.dataset.duppage;
    const copy = structuredClone(doc.pages[i]);
    copy.id = uid();
    copy.els.forEach((e) => { e.id = uid(); });
    doc.pages.splice(i + 1, 0, copy);
    doc.active = i + 1; sel = [];
    commit(); renderAll(); buildThumbs(); zoomFit();
    return;
  }
  const del = ev.target.closest("[data-delpage]");
  if (del) {
    doc.pages.splice(+del.dataset.delpage, 1);
    doc.active = clamp(doc.active, 0, doc.pages.length - 1); sel = [];
    commit(); renderAll(); return;
  }
  const th = ev.target.closest("[data-page]");
  if (th) {
    doc.active = +th.dataset.page; sel = []; editingId = null;
    // Navigation is a view change, not an edit. Without refreshing the baseline
    // the next undo rewinds the page switch too, throwing you onto another page
    // and making the edit look like it was never undone.
    baseline = snap();
    renderAll(); zoomFit();
  }
});



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
      for (const p of doc.pages) {
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

/* import / upload */
$("importBtn").addEventListener("click", () => $("fileJson").click());
$("fileJson").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    if (!o.pages?.length) throw new Error("no pages");
    doc = o; doc.active = clamp(doc.active | 0, 0, doc.pages.length - 1); sel = [];
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

const typing = () => {
  const a = document.activeElement;
  const el = a as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
};
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !typing()) { spaceDown = true; $("stage").style.cursor = "grab"; }
  if (typing()) { if (e.key === "Escape") (document.activeElement as HTMLElement).blur(); return; }
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  if (mod && k === "c") { e.preventDefault(); copySel(); return; }
  if (mod && k === "v") { e.preventDefault(); paste(); return; }
  if (mod && k === "d") { e.preventDefault(); duplicateSel(); return; }
  if (mod && k === "a") { e.preventDefault(); sel = page().els.filter((x) => !x.hidden).map((x) => x.id); renderAll(); return; }
  if (mod && (k === "=" || k === "+")) { e.preventDefault(); $("zoomin").click(); return; }
  if (mod && k === "-") { e.preventDefault(); $("zoomout").click(); return; }
  if (mod && k === "0") { e.preventDefault(); zoomFit(); return; }
  if (mod && e.key === "]") { e.preventDefault(); order("up"); return; }
  if (mod && e.key === "[") { e.preventDefault(); order("down"); return; }
  if (e.key === "Delete" || e.key === "Backspace") { if (sel.length) { e.preventDefault(); deleteSel(); } return; }
  if (e.key === "Escape") { sel = []; editingId = null; setTool("select"); renderAll(); return; }
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
  renderCanvas(); renderPages(); renderProps(); renderLayers();
}

// The app now has three routes (login/console/editor) sharing one page, and
// this container starts hidden. Booting here — instead of at module-eval
// time — matters because zoomFit() reads the stage's bounding box: measured
// while display:none, that box is 0x0 and the initial zoom comes out wrong.
// mountEditor() runs once, the first time the router activates this route.
let editorMounted = false;
let pendingDocument = false;

/** Opens a template by id, preferring the server's copy over the local cache — the server is the source of truth once a template exists there. */
export async function openTemplateById(id: string) {
  try {
    openTemplateDocument(await fetchTemplateFromServer(id));
    return;
  } catch { /* offline, or not created on the server yet — fall back to whatever's local */ }
  const local = loadTemplateLocally(id) ?? (id === TWEET_TEMPLATE_ID ? createTweetTemplateDocument() : null);
  if (local) openTemplateDocument(local);
  else toast("Não foi possível abrir esse template.");
}

export function openTweetTemplate() {
  return openTemplateById(TWEET_TEMPLATE_ID);
}

/** Opens any template document (by value) on the canvas — used for the seed template, an imported JSON file, or one fetched from the server by id. */
export function openTemplateDocument(templateDoc: Doc) {
  doc = templateDoc;
  doc.active = clamp(doc.active | 0, 0, doc.pages.length - 1);
  pendingDocument = true;
  sel = [];
  past = [];
  future = [];
  baseline = snap();
  if (editorMounted) {
    $("docname").value = doc.name;
    renderAll();
    buildThumbs();
    requestAnimationFrame(zoomFit);
  }
}

/** The document on the canvas right now, if it's a template (has a seedId) — null for the untitled/default design. */
export function currentTemplateDocument(): Doc | null {
  return doc.seedId ? structuredClone(doc) : null;
}

export function mountEditor() {
  if (editorMounted) return;
  editorMounted = true;
  if (!pendingDocument) loadPersisted();
  baseline = snap();
  $("docname").value = doc.name || "Untitled design";
  renderRail(); renderToolbelt(); renderPanel(); renderAll(); buildThumbs();
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
