import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");

const d = JSON.parse(fs.readFileSync(path.join(HERE, "figma-node.json"), "utf8"));
const root = d.nodes["1:3"].document;
const SLIDE_W = 1080, SLIDE_H = 1350;

/* ---------- assets ---------- */
const b64 = {};
for (const f of fs.readdirSync(path.join(HERE, "images"))) {
  const ref = f.replace(/^img_/, "").replace(/\.(jpg|png)$/, "");
  const mime = f.endsWith(".png") ? "image/png" : "image/jpeg";
  b64[ref] = `data:${mime};base64,` + fs.readFileSync(path.join(HERE, "images", f)).toString("base64");
}
const refKey = (r) => r.slice(0, 10);
const svgPath = {};
for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith(".svg"))) {
  const id = f.replace(".svg", "").replace("_", ":");
  const t = fs.readFileSync(path.join(HERE, f), "utf8");
  svgPath[id] = {
    path: (t.match(/<path[^>]*\bd="([^"]+)"/) || [])[1],
    viewBox: (t.match(/viewBox="([^"]+)"/) || [])[1] || "0 0 24 24",
  };
}

/* ---------- helpers ---------- */
const hex = (c, mulA = 1) => {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  const a = (c.a === undefined ? 1 : c.a) * mulA;
  return a >= 0.999 ? "#" + h(c.r) + h(c.g) + h(c.b)
    : `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${+a.toFixed(3)})`;
};
// Figma handles are normalised to the node box: handle[0]=start, handle[1]=end
const gradAngle = (p) => {
  const H = p.gradientHandlePositions;
  if (!H || H.length < 2) return 180;
  const dx = H[1].x - H[0].x, dy = H[1].y - H[0].y;
  return (Math.atan2(dx, -dy) * 180) / Math.PI; // CSS: 0deg = up, clockwise
};
const gradOf = (p) => ({
  type: p.type === "GRADIENT_RADIAL" ? "radial" : "linear",
  angle: +gradAngle(p).toFixed(1),
  stops: p.gradientStops.map((s) => [hex(s.color), +s.position.toFixed(4)]),
});
const cssGrad = (g) =>
  g.type === "radial"
    ? `radial-gradient(circle, ${g.stops.map(([c, p]) => `${c} ${Math.round(p * 100)}%`).join(", ")})`
    : `linear-gradient(${g.angle}deg, ${g.stops.map(([c, p]) => `${c} ${Math.round(p * 100)}%`).join(", ")})`;

const PAGE_BG = { r: 1, g: 1, b: 1 };
// A translucent fill must composite over the PAGE, not over the gradient plate
// we slip underneath it — otherwise the plate bleeds through and tints it.
const flatten = (c, mulA = 1) => {
  const a = (c.a === undefined ? 1 : c.a) * mulA;
  if (a >= 0.999) return hex(c);
  const m = (ch, bg) => ch * a + bg * (1 - a);
  return hex({ r: m(c.r, PAGE_BG.r), g: m(c.g, PAGE_BG.g), b: m(c.b, PAGE_BG.b), a: 1 });
};
// Figma grades image fills with its own colour pipeline. CSS filters cover the
// three that matter here; shadows/highlights/temperature have no CSS equivalent
// and are dropped, so a heavily graded photo stays an approximation.
const imgFilter = (f) => {
  if (!f) return null;
  const p = [];
  if (f.exposure) p.push("brightness(" + (1 + f.exposure).toFixed(3) + ")");
  if (f.contrast) p.push("contrast(" + (1 + f.contrast).toFixed(3) + ")");
  if (f.saturation) p.push("saturate(" + (1 + f.saturation).toFixed(3) + ")");
  return p.length ? p.join(" ") : null;
};
let seq = 0;
const uid = () => "f" + (++seq).toString(36) + Math.random().toString(36).slice(2, 5);
const base = (o) => Object.assign({
  id: uid(), name: "Camada", rot: 0, opacity: 1, locked: false, hidden: false,
  fill: "#000000", stroke: "", strokeWidth: 0, radius: 0,
}, o);

const slides = Array.from({ length: 7 }, () => []);
const stats = { text: 0, rect: 0, image: 0, icon: 0, line: 0, gradFill: 0, gradStroke: 0, shadow: 0, blur: 0, skipped: 0, clipped: 0, filtered: 0 };

function visibleFills(n) { return (n.fills || []).filter((f) => f.visible !== false); }

function emit(n, depth, clip) {
  const b = n.absoluteBoundingBox;
  if (!b || n.type === "SLICE") return;
  // Figma frames with clipsContent crop their children. The clipped rect decides
  // WHICH slides an element shows on; its own geometry stays intact so images
  // keep their framing and the page does the actual cropping.
  const vx0 = Math.max(b.x, clip.x0), vx1 = Math.min(b.x + b.width, clip.x1);
  const vy0 = Math.max(b.y, clip.y0), vy1 = Math.min(b.y + b.height, clip.y1);
  // hairlines are legitimately 0px tall — only reject a genuinely empty overlap
  if (vx1 - vx0 < -0.01 || vy1 - vy0 < -0.01) { stats.clipped++; return; }
  const first = Math.max(0, Math.floor((vx0 + 0.5) / SLIDE_W));
  const last = Math.min(6, Math.ceil((vx1 - 0.5) / SLIDE_W) - 1);
  const targets = [];
  for (let k = first; k <= Math.max(first, last); k++) targets.push(k);
  const idx = targets[0];
  const out = slides[idx];
  const X = +(b.x - idx * SLIDE_W).toFixed(1), Y = +b.y.toFixed(1);
  const W = Math.max(1, +b.width.toFixed(1)), H = Math.max(1, +b.height.toFixed(1));
  const rot = n.rotation ? +(-n.rotation * 180 / Math.PI).toFixed(1) : 0;
  const op = n.opacity === undefined ? 1 : n.opacity;
  const radius = typeof n.cornerRadius === "number" ? n.cornerRadius : 0;

  // The ancestor clip must actually crop the element, not merely pick its slide.
  const clipFor = (t) => {
    const cx = +(vx0 - t * SLIDE_W).toFixed(1), cy = +vy0.toFixed(1);
    const cw = +(vx1 - vx0).toFixed(1), ch = +(vy1 - vy0).toFixed(1);
    const ex = +(b.x - t * SLIDE_W).toFixed(1);
    const crops = cx > ex + 0.5 || cy > b.y + 0.5 ||
      cx + cw < ex + b.width - 0.5 || cy + ch < b.y + b.height - 0.5;
    return crops ? { clip: { x: cx, y: cy, w: cw, h: ch } } : {};
  };
  const eff = (n.effects || []).filter((e) => e.visible !== false);
  const drop = eff.find((e) => e.type === "DROP_SHADOW");
  const lblur = eff.find((e) => e.type === "LAYER_BLUR");
  const extra = {};
  if (drop) { extra.shadow = { x: drop.offset.x, y: drop.offset.y, blur: drop.radius, spread: drop.spread || 0, color: hex(drop.color) }; stats.shadow++; }
  if (lblur) { extra.blur = +lblur.radius.toFixed(1); stats.blur++; }

  /* ---- TEXT ---- */
  if (n.type === "TEXT") {
    const st = n.style || {};
    const f = visibleFills(n)[0];
    out.push(base({
      type: "text", name: n.name.slice(0, 40), x: X, y: Y, w: W, h: H, rot, opacity: op,
      text: n.characters,
      font: "Montserrat", size: +(st.fontSize || 16).toFixed(2),
      weight: st.fontWeight || 400,
      italic: (st.italic === true) || /Italic/i.test(st.fontPostScriptName || ""),
      underline: st.textDecoration === "UNDERLINE",
      align: (st.textAlignHorizontal || "LEFT").toLowerCase(),
      lh: st.lineHeightPx ? +(st.lineHeightPx / (st.fontSize || 16)).toFixed(4) : 1.2,
      ls: +(st.letterSpacing || 0).toFixed(2),
      fill: f && f.type === "SOLID" ? hex(f.color, f.opacity ?? 1) : "#000000",
      ...extra, ...clipFor(idx),
    }));
    stats.text++;
    return;
  }

  /* ---- VECTOR ---- */
  if (n.type === "VECTOR") {
    const sp = svgPath[n.id];
    const f = visibleFills(n)[0];
    if (sp && sp.path) {
      out.push(base({
        type: "icon", name: n.name.slice(0, 40), x: X, y: Y, w: W, h: H, rot, opacity: op,
        viewBox: sp.viewBox, path: sp.path,
        fill: f && f.type === "SOLID" ? hex(f.color, f.opacity ?? 1) : "#162576",
        ...extra, ...clipFor(idx),
      }));
      stats.icon++;
    } else {
      // stroked hairline (411x0) -> a line element
      const s = (n.strokes || [])[0];
      const w = n.strokeWeight || 1;
      let fill = "#162576", grad = null;
      if (s && s.type === "SOLID") fill = hex(s.color, s.opacity ?? 1);
      else if (s && s.type.startsWith("GRADIENT")) { grad = gradOf(s); fill = cssGrad(grad); stats.gradStroke++; }
      out.push(base({
        type: "line", name: n.name.slice(0, 40), x: X, y: Y - w / 2, w: W, h: w, rot, opacity: op,
        fill, ...(grad ? { grad } : {}), ...extra, ...clipFor(idx),
      }));
      stats.line++;
    }
    return;
  }

  /* ---- FRAME / RECTANGLE / GROUP ---- */
  const fills = visibleFills(n);
  const img = fills.find((f) => f.type === "IMAGE");
  const solid = fills.find((f) => f.type === "SOLID");
  const grd = fills.find((f) => f.type && f.type.startsWith("GRADIENT"));
  const strokes = (n.strokes || []).filter((s) => s.visible !== false);
  const sw = n.strokeWeight || 0;
  const sGrad = strokes.find((s) => s.type && s.type.startsWith("GRADIENT"));
  const sSolid = strokes.find((s) => s.type === "SOLID");

  // A gradient border has no CSS equivalent that survives editing, so split it
  // into a gradient plate with the real fill inset on top — both stay editable.
  if (sGrad && sw > 0) {
    const g = gradOf(sGrad);
    // strokeAlign decides where the 8px band actually sits relative to the box
    const al = n.strokeAlign || "INSIDE";
    const grow = al === "OUTSIDE" ? sw : al === "CENTER" ? sw / 2 : 0;
    const inset = al === "INSIDE" ? sw : 0;
    for (const t of targets) {
      const ox = +(b.x - t * SLIDE_W).toFixed(1);
      slides[t].push(base({
        type: "rect", name: n.name.slice(0, 32) + " · borda",
        x: +(ox - grow).toFixed(1), y: +(Y - grow).toFixed(1),
        w: +(W + grow * 2).toFixed(1), h: +(H + grow * 2).toFixed(1),
        rot, opacity: op, radius: radius ? radius + grow : 0, fill: cssGrad(g), grad: g,
        ring: sw, ...extra, ...clipFor(t),
      }));
      stats.gradStroke++; stats.rect++;
      if (solid || grd || img) {
        const inner = {
          type: "rect", name: n.name.slice(0, 32) + " · interno",
          x: +(ox + inset).toFixed(1), y: +(Y + inset).toFixed(1),
          w: Math.max(1, W - inset * 2), h: Math.max(1, H - inset * 2), rot, opacity: op,
          radius: Math.max(0, radius - inset),
        };
        if (img) { inner.type = "image"; inner.src = "@" + refKey(img.imageRef); const ff = imgFilter(img.filters); if (ff) { inner.filter = ff; stats.filtered++; } }
        else if (grd) { const g2 = gradOf(grd); inner.fill = cssGrad(g2); inner.grad = g2; stats.gradFill++; }
        else inner.fill = hex(solid.color, solid.opacity ?? 1);
        slides[t].push(base({ ...inner, ...clipFor(t) }));
        stats[img ? "image" : "rect"]++;
      }
    }
    return;
  }

  if (!fills.length && !strokes.length) { stats.skipped++; return; } // pure layout frame

  const el = {
    name: n.name.slice(0, 40), x: X, y: Y, w: W, h: H, rot, opacity: op, radius,
    stroke: sSolid ? hex(sSolid.color, sSolid.opacity ?? 1) : "",
    strokeWidth: sSolid ? sw : 0,
    ...extra,
  };
  if (img) { el.type = "image"; el.src = "@" + refKey(img.imageRef); const ff = imgFilter(img.filters); if (ff) { el.filter = ff; stats.filtered++; } stats.image++; }
  else if (grd) { const g = gradOf(grd); el.type = "rect"; el.fill = cssGrad(g); el.grad = g; stats.gradFill++; stats.rect++; }
  else if (solid) { el.type = "rect"; el.fill = hex(solid.color, solid.opacity ?? 1); stats.rect++; }
  else { el.type = "rect"; el.fill = "transparent"; stats.rect++; }
  for (const t of targets) slides[t].push(base({ ...el, id: uid(), x: +(b.x - t * SLIDE_W).toFixed(1), ...clipFor(t) }));
}

function walk(n, depth, clip) {
  if (n.visible === false) return;
  emit(n, depth, clip);
  const b = n.absoluteBoundingBox;
  const next = (n.clipsContent && b)
    ? { x0: Math.max(clip.x0, b.x), y0: Math.max(clip.y0, b.y),
        x1: Math.min(clip.x1, b.x + b.width), y1: Math.min(clip.y1, b.y + b.height) }
    : clip;
  (n.children || []).forEach((c) => walk(c, depth + 1, next));
}
const rb = root.absoluteBoundingBox;
const rootClip = { x0: rb.x, y0: rb.y, x1: rb.x + rb.width, y1: rb.y + rb.height };
(root.children || []).forEach((c) => walk(c, 0, rootClip));

const doc = {
  name: "BR Arena — Carrossel 01",
  assets: b64,
  pages: slides.map((els, i) => ({ id: "br-" + (i + 1), w: SLIDE_W, h: SLIDE_H, bg: "#FFFFFF", els })),
  active: 0,
};
const OUT = path.resolve(HERE, "../src/seed.json");
const crypto = await import("node:crypto");
doc.seedId = "brarena-" + crypto.createHash("sha1").update(JSON.stringify(doc.pages)).digest("hex").slice(0, 8);
fs.writeFileSync(OUT, JSON.stringify(doc));
console.log("elementos por slide:", slides.map((s) => s.length).join(", "));
console.log("stats:", JSON.stringify(stats));
console.log("seedId:", doc.seedId);
console.log("src/seed.json:", (fs.statSync(OUT).size / 1024 / 1024).toFixed(2) + " MB");
