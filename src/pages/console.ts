import { navigate } from "../router";
import { currentTweetTemplateDocument, openTweetTemplate } from "../editor";

/**
 * Ported from "Wireframe Sidebar.dc.html". Same focus-preservation rule as
 * login.ts: any element the user might be mid-typing into is never touched
 * by a full render() — only `state` is updated, plus a narrow, targeted DOM
 * patch for the one or two things the original showed updating live (the
 * code snippet as you type a layer value or the API key; the block/word
 * count as you paste import text). Everything else — nav, tabs, chips,
 * selects, add/remove, render, copy, revoke — is a discrete action with no
 * focused text field at risk, so a full render() is simplest and correct.
 */

type View = "templates" | "playground" | "import" | "keys";
const VIEWS: View[] = ["templates", "playground", "import", "keys"];
const DEFAULT_VIEW: View = "playground";

/** Reads the console's own sub-route out of `#/console/<view>`, so refresh/back-forward/deep links work. */
function viewFromHash(): View {
  const match = /^#\/console\/([a-z]+)/.exec(location.hash);
  const candidate = match?.[1];
  return VIEWS.includes(candidate as View) ? (candidate as View) : DEFAULT_VIEW;
}

function goToView(view: View) {
  location.hash = `/console/${view}`;
}
type LayerType = "text" | "image";

interface Layer { id: number; type: LayerType; name: string; value: string; }
interface ApiKey { id: number; name: string; secret: string; created: string; lastUsed: string; revealed: boolean; }
interface AppDoc { name: string; meta: string; }

interface State {
  view: View;
  template: string;
  format: string;
  page: string;
  apiKey: string;
  scope: string;
  layers: Layer[];
  collapsed: boolean;
  sort: string;
  period: string;
  impTab: "Texto" | "Imagens" | "Fontes" | "Apps";
  importUrl: string;
  textDraft: string;
  textModalOpen: boolean;
  lastAdded: string;
  app: "Canva" | "Figma" | null;
  appUrl: string;
  appDoc: string | null;
  tab: "preview" | "response";
  lang: "JavaScript" | "Python" | "cURL" | "PHP";
  rendering: boolean;
  rendered: boolean;
  response: string | null;
  previewUrl: string | null;
  copiedCode: boolean;
  copied: number | null;
  keys: ApiKey[];
}

const state: State = {
  view: "playground",
  template: "Twitter mínimo",
  format: "png",
  page: "1",
  apiKey: "blk_local_dev",
  scope: "global",
  layers: [
    { id: 1, type: "image", name: "avatar", value: "https://github.com/github.png" },
    { id: 2, type: "text", name: "displayName", value: "Micael Crasto" },
    { id: 3, type: "text", name: "handle", value: "@MicaelCrasto" },
    { id: 4, type: "text", name: "tweetText", value: "Template local funcionando de verdade." },
  ],
  collapsed: false,
  sort: "Ordem",
  period: "Todos",
  impTab: "Texto",
  importUrl: "",
  textDraft: "",
  textModalOpen: false,
  lastAdded: "",
  app: null,
  appUrl: "",
  appDoc: null,
  tab: "preview",
  lang: "JavaScript",
  rendering: false,
  rendered: false,
  response: null,
  previewUrl: null,
  copiedCode: false,
  copied: null,
  keys: [
    { id: 1, name: "production", secret: "sk_live_9f2b41ac77de", created: "Mar 12, 2026", lastUsed: "2h ago", revealed: false },
    { id: 2, name: "staging", secret: "sk_test_4ac0e18bb3f1", created: "Apr 02, 2026", lastUsed: "5d ago", revealed: false },
    { id: 3, name: "local-dev", secret: "sk_test_71de99c40aa2", created: "Jun 21, 2026", lastUsed: "never", revealed: false },
  ],
};

const TEMPLATE_IDS: Record<string, string> = {
  "Twitter mínimo": "tweet-screenshot",
};

const IMP_META: Record<string, { placeholder: string; accept: string }> = {
  Texto: { placeholder: "", accept: "" },
  Imagens: { placeholder: "https://cdn.exemplo.com/foto.png", accept: "png · jpg · webp · svg" },
  Fontes: { placeholder: "https://fonts.exemplo.com/familia.woff2", accept: "woff2 · woff · ttf · otf" },
};

const APP_META: Record<string, { hint: string; placeholder: string; docs: AppDoc[] }> = {
  Canva: {
    hint: "Escolha um design da sua conta ou cole o link.",
    placeholder: "https://www.canva.com/design/…",
    docs: [
      { name: "Carrossel BR Arena", meta: "4 páginas" },
      { name: "Story Promo Setembro", meta: "2 páginas" },
      { name: "Kit Marca 2026", meta: "11 páginas" },
    ],
  },
  Figma: {
    hint: "Cole o link do frame ou selecione um arquivo recente.",
    placeholder: "https://figma.com/file/…?node-id=",
    docs: [
      { name: "Arena / Frame 12", meta: "1 frame" },
      { name: "Social Kit / Carrossel", meta: "6 frames" },
      { name: "Brand / Tokens", meta: "3 páginas" },
    ],
  },
};

const TEXT_PLACEHOLDER =
  "Bloco #1\n\nSeu primeiro bloco aqui…\n\n================================================================\n\nBloco #2\n\nSegundo bloco…";

let root: HTMLElement;
let bound = false;
let copyKeyTimer: ReturnType<typeof setTimeout> | undefined;
let copyCodeTimer: ReturnType<typeof setTimeout> | undefined;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function filledLayers(): Layer[] {
  return state.layers.filter((l) => l.value.trim() !== "");
}

function requestLayers(): Record<string, { text?: string; image_url?: string }> {
  return Object.fromEntries(
    filledLayers().map((layer) => [
      layer.name,
      layer.type === "image" ? { image_url: layer.value.trim() } : { text: layer.value },
    ]),
  );
}

function snippetFor(lang: State["lang"]): string {
  const s = state;
  const jsonLayers = JSON.stringify(requestLayers());
  const key = s.apiKey || "SUA_API_KEY";
  const url = "http://localhost:8787/api/v1/render";
  const tid = TEMPLATE_IDS[s.template];

  if (lang === "Python") {
    return `import requests\n\nr = requests.post(\n    "${url}",\n    headers={"Authorization": "Bearer ${key}"},\n    json={\n        "template": "${tid}",\n        "layers": ${jsonLayers},\n        "document": template_document,  # JSON salvo pelo editor\n    },\n)\nr.raise_for_status()\nopen("twitter.png", "wb").write(r.content)`;
  }
  if (lang === "cURL") {
    return `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '{"template":"${tid}","layers":${jsonLayers},"document":{...}}' \\\n  --output twitter.png`;
  }
  if (lang === "PHP") {
    return `$png = Http::withToken("${key}")\n    ->post("${url}", [\n        "template" => "${tid}",\n        "layers"   => $layers,\n        "document" => $templateDocument,\n    ])->throw()->body();\n\nfile_put_contents("twitter.png", $png);`;
  }
  return `const templateDocument = JSON.parse(\n  localStorage.getItem("blank-editor-template-tweet-screenshot-v1"),\n);\n\nconst response = await fetch("${url}", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n    Authorization: "Bearer ${key}",\n  },\n  body: JSON.stringify({\n    template: "${tid}",\n    layers: ${jsonLayers},\n    document: templateDocument,\n  }),\n});\n\nif (!response.ok) throw new Error(await response.text());\nconst png = await response.blob();`;
}

function patchSnippetLive() {
  const el = document.getElementById("codeSnippet");
  if (el) el.textContent = snippetFor(state.lang);
}

async function startRender() {
  if (state.rendering) return;
  state.rendering = true; state.rendered = false; state.response = null;
  render();
  const started = performance.now();
  try {
    const response = await fetch("/api/v1/render", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.apiKey || "blk_local_dev"}`,
      },
      body: JSON.stringify({
        template: TEMPLATE_IDS[state.template],
        layers: requestLayers(),
        document: currentTweetTemplateDocument(),
      }),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);

    const png = await response.blob();
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(png);
    state.rendered = true;
    state.tab = "preview";
    state.response = JSON.stringify({
      ok: true,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: png.size,
      renderTimeMs: Math.round(performance.now() - started),
    }, null, 2);
  } catch (error) {
    state.previewUrl = null;
    state.tab = "response";
    state.response = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
  } finally {
    state.rendering = false;
    render();
  }
}

function addLayer(type: LayerType) {
  const n = state.layers.filter((l) => l.type === type).length + 1;
  state.layers.push({ id: Date.now(), type, name: (type === "text" ? "texto_" : "imagem_") + n, value: "" });
  render();
}

function createKey() {
  const rnd = () => Math.random().toString(16).slice(2, 8);
  state.keys.unshift({ id: Date.now(), name: "key-" + (state.keys.length + 1), secret: "sk_test_" + rnd() + rnd(), created: "Aug 27, 2026", lastUsed: "never", revealed: true });
  render();
}

const selOptions = (current: string, options: string[]) =>
  options.map((o) => `<option value="${esc(o)}" ${o === current ? "selected" : ""}>${esc(o)}</option>`).join("");

function chip(name: string, active: boolean, action: string, value: string) {
  return `<div data-action="${action}" data-value="${esc(value)}" style="cursor:pointer; height:26px; padding:0 12px; border-radius:6px; display:flex; align-items:center; font-size:12px; font-weight:500; background:${active ? "var(--accent)" : "transparent"}; color:${active ? "#111111" : "var(--muted)"};">${esc(name)}</div>`;
}

function tab(name: string, active: boolean, action: string) {
  return `<div data-action="${action}" style="cursor:pointer; height:32px; padding:0 16px; border-radius:7px; display:flex; align-items:center; font-size:13px; font-weight:500; background:${active ? "var(--accent)" : "transparent"}; color:${active ? "#111111" : "var(--muted)"};">${esc(name)}</div>`;
}

/* ---------------------------------------------------------------------- */

function renderSidebar(): string {
  const s = state;
  const expanded = !s.collapsed;
  const asideW = s.collapsed ? "64px" : "224px";
  const navJustify = s.collapsed ? "center" : "flex-start";
  const brandJustify = s.collapsed ? "center" : "flex-start";

  const navItem = (label: string, view: View, action: string, icon: string) => {
    const active = s.view === view;
    return `
      <div data-action="${action}" style="cursor:pointer; display:flex; align-items:center; gap:10px; height:34px; padding:0 10px; border-radius:7px; font-size:13px; font-weight:500; justify-content:${navJustify}; background:${active ? "var(--surface-2)" : "transparent"}; border:1px solid ${active ? "var(--border-strong)" : "transparent"}; color:${active ? "var(--text)" : "var(--muted)"};">
        ${icon}
        ${expanded ? `<span style="white-space:nowrap;">${esc(label)}</span>` : ""}
      </div>`;
  };

  return `
    <aside style="width:${asideW}; flex:none; border-right:1px solid var(--border); background:var(--surface); display:flex; flex-direction:column; padding:14px 0;">
      <div style="display:flex; align-items:center; gap:10px; padding:0 12px 14px; justify-content:${brandJustify};">
        ${expanded ? `
        <div style="width:26px; height:26px; flex:none; border-radius:7px; border:1px solid var(--border-strong); background:var(--surface-2); display:flex; align-items:center; justify-content:center; font-family:var(--display); font-size:11px; font-weight:600; color:var(--muted);">L</div>
        <span style="flex:1; font-family:var(--display); font-size:13px; font-weight:600; letter-spacing:-0.01em; white-space:nowrap;">Acme Console</span>` : ""}
        <div data-action="toggle-aside" title="${s.collapsed ? "Expandir menu" : "Recolher menu"}" style="cursor:pointer; width:26px; height:26px; flex:none; border-radius:7px; display:flex; align-items:center; justify-content:center;">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.75" width="12" height="10.5" rx="1.8"></rect><path d="M6.2 2.75v10.5"></path></svg>
        </div>
      </div>

      <div style="padding:0 8px 14px;">
        <div style="height:32px; border-radius:7px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; justify-content:center; padding:0 10px; gap:8px;">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--faint)" stroke-width="1.4" stroke-linecap="round" style="flex:none;"><circle cx="7" cy="7" r="4.5"></circle><path d="M10.5 10.5 14 14"></path></svg>
          ${expanded ? `<span style="flex:1; font-size:12px; color:var(--faint);">Search…</span>` : ""}
        </div>
      </div>

      ${expanded ? `<div style="padding:0 16px 8px; font-size:10px; letter-spacing:0.1em; text-transform:uppercase; color:var(--faint);">Platform</div>` : ""}

      <nav style="display:flex; flex-direction:column; gap:2px; padding:0 8px;">
        ${navItem("Templates", "templates", "go-templates", `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" style="flex:none;"><rect x="1.75" y="1.75" width="5.2" height="5.2" rx="1.2"></rect><rect x="9.05" y="1.75" width="5.2" height="5.2" rx="1.2"></rect><rect x="1.75" y="9.05" width="5.2" height="5.2" rx="1.2"></rect><rect x="9.05" y="9.05" width="5.2" height="5.2" rx="1.2"></rect></svg>`)}
        ${navItem("Playground", "playground", "go-playground", `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><rect x="1.75" y="2.5" width="12.5" height="11" rx="1.6"></rect><path d="M4.6 6.4 6.6 8l-2 1.6"></path><path d="M8.4 10.1h3"></path></svg>`)}
        ${navItem("Importar", "import", "go-import", `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="M8 10.4V2.6"></path><path d="M5.2 5.4 8 2.6l2.8 2.8"></path><path d="M2.6 10.9v1.9c0 .4.3.6.7.6h9.4c.4 0 .7-.2.7-.6v-1.9"></path></svg>`)}
        ${navItem("API keys", "keys", "go-keys", `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><circle cx="10.4" cy="5.6" r="3.35"></circle><path d="M8.05 7.95 2.6 13.4"></path><path d="M4.5 11.5l1.4 1.4"></path></svg>`)}
      </nav>

      <div style="flex:1;"></div>

      <div style="margin:0 8px; padding:8px; border-radius:7px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; justify-content:center; gap:10px;">
        <div style="width:28px; height:28px; flex:none; border-radius:50%; border:1px solid var(--border-strong); background:var(--avatar);"></div>
        ${expanded ? `
        <div style="display:flex; flex-direction:column; gap:6px; flex:1; min-width:0;">
          <div style="height:8px; width:70%; border-radius:3px; background:var(--border-strong);"></div>
          <div style="height:7px; width:90%; border-radius:3px; background:var(--border);"></div>
        </div>` : ""}
      </div>
    </aside>`;
}

function renderTemplates(): string {
  const s = state;
  const sortChips = ["Ordem", "A-Z"].map((n) => chip(n, s.sort === n, "pick-sort", n)).join("");
  const periodChips = ["Todos", "Hoje", "7D", "14D", "30D"].map((n) => chip(n, s.period === n, "pick-period", n)).join("");
  const cardStyle = "aspect-ratio:16/9; border-radius:7px; border:1px dashed var(--border); background:repeating-linear-gradient(45deg, var(--surface) 0 6px, #1E1E1B 6px 12px); display:flex; align-items:center; justify-content:center; font-family:var(--mono); font-size:11px; color:var(--faint); cursor:pointer;";
  const cards = `<div data-action="open-twitter-template" style="${cardStyle}; flex-direction:column; gap:8px;"><strong style="font-family:var(--display); font-size:14px; color:var(--text);">Twitter mínimo</strong><span>clique para editar · nome · @ · texto · foto</span></div>`;

  return `
    <div style="display:flex; flex-direction:column; gap:16px; padding:20px;">
      <div style="display:flex; align-items:center; gap:18px; flex-wrap:wrap;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:12px; color:var(--faint);">Ordenar:</span>
          <div style="display:flex; align-items:center; gap:4px; padding:4px; border-radius:9px; border:1px solid var(--border); background:var(--surface);">${sortChips}</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:12px; color:var(--faint);">Período:</span>
          <div style="display:flex; align-items:center; gap:4px; padding:4px; border-radius:9px; border:1px solid var(--border); background:var(--surface);">${periodChips}</div>
        </div>
        <div style="flex:1;"></div>
        <div data-action="go-import" style="cursor:pointer; height:34px; padding:0 14px; border-radius:8px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; gap:7px; font-size:12px; color:var(--muted);">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.4V2.6"></path><path d="M5.2 5.4 8 2.6l2.8 2.8"></path><path d="M2.6 10.9v1.9c0 .4.3.6.7.6h9.4c.4 0 .7-.2.7-.6v-1.9"></path></svg>
          <span>Importar</span>
        </div>
        <div data-action="open-editor" style="cursor:pointer; height:34px; padding:0 14px; border-radius:8px; background:var(--accent); color:#111111; display:flex; align-items:center; gap:7px; font-size:12px; font-weight:500;">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3.2v9.6"></path><path d="M3.2 8h9.6"></path></svg>
          <span>Novo template</span>
        </div>
      </div>
      <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:16px;">${cards}</div>
    </div>`;
}

function renderPlayground(): string {
  const s = state;
  const noLayers = s.layers.length === 0;

  const layerCards = s.layers.map((l) => `
    <div style="border-radius:9px; border:1px solid var(--border); background:#161614; padding:12px; display:flex; flex-direction:column; gap:10px;">
      <div style="display:flex; align-items:center; gap:9px;">
        ${l.type === "text"
      ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-linecap="round" style="flex:none;"><path d="M3 3.6h10"></path><path d="M8 3.6v9"></path></svg>`
      : `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-linejoin="round" style="flex:none;"><rect x="2" y="3" width="12" height="10" rx="1.6"></rect><circle cx="5.9" cy="6.5" r="1.05"></circle><path d="M2.6 11.4 6.4 8l3 2.6 2-1.7 2 2.1"></path></svg>`}
        <span style="flex:1; font-family:var(--mono); font-size:12px; color:var(--text);">${esc(l.name)}</span>
      </div>
      <input data-layer-value="${l.id}" value="${esc(l.value)}" placeholder="${l.type === "text" ? "Texto dinâmico" : "URL da imagem"}" class="console-field" style="height:38px;" />
    </div>`).join("");

  const langs: State["lang"][] = ["JavaScript", "Python", "cURL", "PHP"];
  const langChips = langs.map((n) => tab(n, s.lang === n, "pick-lang-" + n)).join("");

  const previewText = s.rendering
    ? "Gerando render…"
    : s.rendered
      ? `render pronto · PNG real · ${filledLayers().length} campos`
      : "Preencha as camadas e clique em “Gerar render” para ver o resultado aqui.";

  return `
    <div style="flex:1; display:grid; grid-template-columns:380px minmax(0, 1fr); gap:20px; padding:20px; align-items:start; min-height:0;">

      <div style="border-radius:12px; border:1px solid var(--border); background:var(--surface); padding:18px; display:flex; flex-direction:column; gap:16px;">
        <div style="display:flex; flex-direction:column; gap:8px;">
          <span style="font-size:13px; font-weight:500;">Template</span>
          <select data-select="template" class="console-field">${selOptions(s.template, Object.keys(TEMPLATE_IDS))}</select>
          <span id="templateIdText" style="font-family:var(--mono); font-size:11px; color:var(--faint);">${esc(TEMPLATE_IDS[s.template])}</span>
          <div data-action="open-twitter-template" style="cursor:pointer; height:32px; border-radius:7px; border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:12px; color:var(--muted);">Editar template no canvas</div>
        </div>

        <div style="display:flex; flex-direction:column; gap:7px; min-width:0;">
          <span style="font-size:12px; color:var(--muted);">API key local</span>
          <input data-field="apiKey" value="${esc(s.apiKey)}" class="console-field" style="height:36px; font-family:var(--mono); font-size:11px;" />
          <span style="font-family:var(--mono); font-size:10px; color:var(--faint);">POST /api/v1/render → localhost:8787</span>
        </div>

        <div style="display:flex; align-items:center; gap:12px;">
          <span style="font-size:13px; font-weight:500; flex:1;">Campos do template</span>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px;">
          ${layerCards}
          ${noLayers ? `<div style="border-radius:9px; border:1px dashed var(--border); padding:22px; text-align:center; font-family:var(--mono); font-size:11px; color:var(--faint);">nenhuma camada</div>` : ""}
        </div>

        <span style="font-size:12px; color:var(--faint);">Os quatro campos são obrigatórios. A foto deve ser uma URL pública.</span>

        <div data-action="render" style="cursor:pointer; height:46px; border-radius:9px; background:var(--accent); color:#111111; display:flex; align-items:center; justify-content:center; gap:9px; font-size:14px; font-weight:500;">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8 12.8 8l-8.3 5.2z"></path></svg>
          <span>${s.rendering ? "Gerando…" : "Gerar render"}</span>
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:16px; min-width:0;">
        <div style="display:flex; align-items:center; gap:4px; padding:5px; border-radius:10px; border:1px solid var(--border); background:var(--surface); align-self:flex-start;">
          ${tab("Preview", s.tab === "preview", "show-preview")}
          ${tab("Response", s.tab === "response", "show-response")}
        </div>

        ${s.tab === "preview" ? `
        <div style="min-height:380px; border-radius:12px; border:1px solid var(--border); background:#161614; display:flex; align-items:center; justify-content:center; padding:32px; text-align:center;">
          ${s.previewUrl
            ? `<img id="renderPreview" src="${esc(s.previewUrl)}" alt="Preview do tweet renderizado" style="display:block; max-width:100%; height:auto; border-radius:8px;" />`
            : `<span style="max-width:380px; font-size:14px; line-height:1.6; color:var(--faint);">${esc(previewText)}</span>`}
        </div>` : `
        <div style="min-height:380px; border-radius:12px; border:1px solid var(--border); background:#161614; padding:18px; font-family:var(--mono); font-size:12px; line-height:1.7; color:var(--muted); white-space:pre-wrap; overflow:auto;">${esc(s.response || "// sem resposta ainda — gere um render")}</div>`}

        <div style="display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; align-items:center; gap:4px;">
            ${langChips}
            <div style="flex:1;"></div>
            <div data-action="copy-code" style="cursor:pointer; height:32px; padding:0 12px; border-radius:7px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; gap:7px; font-size:12px; color:var(--muted);">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"></rect><path d="M10.5 3.2V2.5h-8v8h0.7"></path></svg>
              <span>${s.copiedCode ? "Copiado" : "Copiar"}</span>
            </div>
          </div>
          <div id="codeSnippet" style="border-radius:12px; border:1px solid var(--border); background:#161614; padding:18px; font-family:var(--mono); font-size:12px; line-height:1.75; color:var(--text); white-space:pre; overflow:auto;">${esc(snippetFor(s.lang))}</div>
        </div>
      </div>
    </div>`;
}

function renderImport(): string {
  const s = state;
  const meta = IMP_META[s.impTab] || IMP_META.Texto;
  const app = s.app ? APP_META[s.app] : null;

  const words = s.textDraft.trim() ? s.textDraft.trim().split(/\s+/).length : 0;
  const raw = s.textDraft.trim();
  const blocks = raw
    ? raw.split(/\n\s*={3,}\s*\n|\n(?=\s*(?:bloco|tweet|post)\s*#\d+)/i).map((x) => x.trim()).filter(Boolean).length
    : 0;
  const textStats = `${blocks}${blocks === 1 ? " bloco" : " blocos"} · ${words} palavras`;

  const impTabs = (["Texto", "Imagens", "Fontes", "Apps"] as const)
    .map((n) => tab(n, s.impTab === n, "pick-imp-" + n)).join("");

  let body = "";
  if (s.impTab === "Texto") {
    body = `
      <div style="border-radius:12px; border:1px solid var(--border); background:var(--surface); padding:18px; display:flex; flex-direction:column; gap:14px; max-width:620px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="M12 3v12"></path><path d="m8 11 4 4 4-4"></path><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"></path></svg>
          <span style="flex:1; font-size:14px; font-weight:500;">Importar texto</span>
          <span id="textStatsA" style="font-family:var(--mono); font-size:11px; color:var(--faint);">${esc(textStats)}</span>
        </div>
        <span style="font-size:12px; line-height:1.6; color:var(--faint);">Cole o texto e os blocos serão detectados automaticamente por delimitadores (===) ou cabeçalhos (Bloco #1, Bloco #2…).</span>
        <div data-action="open-text-modal" style="cursor:pointer; align-self:flex-start; height:38px; padding:0 16px; border-radius:8px; background:var(--accent); color:#111111; display:flex; align-items:center; gap:8px; font-size:13px; font-weight:500;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="m8 11 4 4 4-4"></path><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"></path></svg>
          <span>Colar texto</span>
        </div>
      </div>`;
  } else if (s.impTab === "Apps") {
    const appCard = (name: "Canva" | "Figma", state_: string) => `
      <div data-action="open-app-${name}" style="cursor:pointer; border-radius:12px; border:1px solid var(--border); background:var(--surface); padding:18px; display:flex; flex-direction:column; gap:14px;">
        <div style="display:flex; align-items:center; gap:12px;">
          <div style="width:38px; height:38px; flex:none; border-radius:9px; border:1px solid var(--border-strong); background:var(--avatar);"></div>
          <div style="flex:1; display:flex; flex-direction:column; gap:3px;">
            <span style="font-size:14px; font-weight:500;">${name}</span>
            <span style="font-family:var(--mono); font-size:10px; color:var(--faint);">${esc(state_)}</span>
          </div>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--faint)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"></path></svg>
        </div>
        <span style="font-size:12px; line-height:1.6; color:var(--faint);">${name === "Canva" ? "Importar um design ou pasta compartilhada." : "Colar link do frame ou arquivo."}</span>
      </div>`;
    body = `<div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:16px; max-width:860px;">${appCard("Canva", "conectado")}${appCard("Figma", "conectar")}</div>`;
  } else {
    body = `
      <div style="border-radius:12px; border:1px solid var(--border); background:var(--surface); padding:18px; display:flex; flex-direction:column; gap:14px; max-width:860px;">
        <div style="display:flex; flex-direction:column; gap:8px;">
          <span style="font-size:12px; color:var(--muted);">Importar por link</span>
          <div style="display:flex; gap:10px;">
            <input data-field="importUrl" value="${esc(s.importUrl)}" placeholder="${esc(meta.placeholder)}" class="console-field" style="flex:1; min-width:0; font-family:var(--mono); font-size:12px;" />
            <div data-action="add-from-url" style="cursor:pointer; flex:none; height:40px; padding:0 16px; border-radius:8px; background:var(--accent); color:#111111; display:flex; align-items:center; font-size:13px; font-weight:500;">Importar</div>
          </div>
        </div>
        <div data-action="add-from-file" style="cursor:pointer; border-radius:10px; border:1px dashed var(--border); background:#161614; padding:44px; display:flex; flex-direction:column; align-items:center; gap:10px; text-align:center;">
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="var(--faint)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V2.8"></path><path d="M5.4 5.4 8 2.8l2.6 2.6"></path><path d="M2.8 11.4v1.4c0 .4.3.7.7.7h9c.4 0 .7-.3.7-.7v-1.4"></path></svg>
          <span style="font-size:13px; color:var(--muted);">Arraste arquivos ou clique para selecionar</span>
          <span style="font-family:var(--mono); font-size:11px; color:var(--faint);">${esc(meta.accept)}</span>
        </div>
        <span style="font-size:12px; color:var(--faint);">${esc(s.lastAdded || "Nada importado nesta sessão.")}</span>
      </div>`;
  }

  const textModal = s.textModalOpen ? `
    <div data-action="close-text-modal" style="position:fixed; inset:0; background:rgba(10,10,9,0.72); display:flex; align-items:center; justify-content:center; z-index:30; padding:24px;">
      <div data-stop="1" style="position:relative; width:100%; max-width:640px; max-height:80vh; overflow:auto; border-radius:12px; border:1px solid var(--border-strong); background:var(--surface); box-shadow:var(--shadow); padding:24px; display:flex; flex-direction:column; gap:16px;">
        <div style="display:flex; align-items:center; gap:9px; padding-right:32px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="M12 3v12"></path><path d="m8 11 4 4 4-4"></path><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"></path></svg>
          <span style="font-family:var(--display); font-size:17px; font-weight:600; letter-spacing:-0.01em;">Importar texto</span>
        </div>
        <span style="font-size:12px; line-height:1.6; color:var(--faint);">Cole seu texto abaixo. Os blocos serão detectados automaticamente por delimitadores (===) ou cabeçalhos (Bloco #1, Bloco #2…).</span>
        <textarea id="textDraftArea" data-field="textDraft" spellcheck="false" placeholder="${esc(TEXT_PLACEHOLDER)}" style="min-height:300px; resize:vertical; border-radius:8px; border:1px solid var(--border); background:#161614; color:var(--text); padding:12px; font-family:var(--mono); font-size:12px; line-height:1.7; outline:none;">${esc(s.textDraft)}</textarea>
        <div style="display:flex; align-items:center; gap:10px;">
          <span id="textStatsB" style="flex:1; font-family:var(--mono); font-size:11px; color:var(--faint);">${esc(textStats)}</span>
          <div data-action="close-text-modal" style="cursor:pointer; height:40px; padding:0 16px; border-radius:8px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; font-size:13px; color:var(--text);">Cancelar</div>
          <div id="importTextBtn" data-action="import-text" style="cursor:pointer; height:40px; padding:0 16px; border-radius:8px; background:var(--accent); color:#111111; display:flex; align-items:center; gap:8px; font-size:13px; font-weight:500; opacity:${blocks ? "1" : "0.45"};">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="m8 11 4 4 4-4"></path><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"></path></svg>
            <span id="importTextLabel">Importar ${blocks}${blocks === 1 ? " bloco" : " blocos"}</span>
          </div>
        </div>
        <div data-action="close-text-modal" style="cursor:pointer; position:absolute; right:14px; top:14px; width:28px; height:28px; border-radius:6px; display:flex; align-items:center; justify-content:center;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
        </div>
      </div>
    </div>` : "";

  const appModal = s.app ? `
    <div data-action="close-app" style="position:fixed; inset:0; background:rgba(10,10,9,0.72); display:flex; align-items:center; justify-content:center; z-index:30;">
      <div data-stop="1" style="width:460px; border-radius:12px; border:1px solid var(--border-strong); background:var(--surface); box-shadow:var(--shadow); padding:20px; display:flex; flex-direction:column; gap:16px;">
        <div style="display:flex; align-items:flex-start; gap:12px;">
          <div style="display:flex; flex-direction:column; gap:5px; flex:1;">
            <span style="font-family:var(--display); font-size:14px; font-weight:600;">Importar do ${esc(s.app)}</span>
            <span style="font-size:12px; color:var(--faint);">${esc(app?.hint || "")}</span>
          </div>
          <div data-action="close-app" style="cursor:pointer; width:26px; height:26px; border-radius:6px; display:flex; align-items:center; justify-content:center;">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--muted)" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8"></path><path d="M12 4l-8 8"></path></svg>
          </div>
        </div>
        <input data-field="appUrl" value="${esc(s.appUrl)}" placeholder="${esc(app?.placeholder || "")}" class="console-field" style="font-family:var(--mono); font-size:12px;" />
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${(app?.docs || []).map((d) => `
          <div data-action="pick-app-doc" data-value="${esc(d.name)}" style="cursor:pointer; border-radius:8px; border:1px solid ${s.appDoc === d.name ? "var(--border-strong)" : "var(--border)"}; background:var(--surface-2); padding:10px 12px; display:flex; align-items:center; gap:10px;">
            <div style="width:26px; height:26px; flex:none; border-radius:6px; border:1px solid var(--border-strong); background:var(--avatar);"></div>
            <span style="flex:1; font-size:12px;">${esc(d.name)}</span>
            <span style="font-family:var(--mono); font-size:10px; color:var(--faint);">${esc(d.meta)}</span>
          </div>`).join("")}
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="flex:1; font-family:var(--mono); font-size:10px; color:var(--faint);">oauth · somente leitura</span>
          <div data-action="close-app" style="cursor:pointer; height:36px; padding:0 14px; border-radius:8px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; font-size:13px; color:var(--muted);">Cancelar</div>
          <div data-action="confirm-app" style="cursor:pointer; height:36px; padding:0 16px; border-radius:8px; background:var(--accent); color:#111111; display:flex; align-items:center; font-size:13px; font-weight:500;">Importar</div>
        </div>
      </div>
    </div>` : "";

  return `
    <div style="flex:1; display:flex; flex-direction:column; gap:18px; padding:20px; min-height:0;">
      <div style="display:flex; flex-direction:column; gap:5px;">
        <span style="font-family:var(--display); font-size:15px; font-weight:600;">Importar</span>
        <span style="font-size:12px; color:var(--faint);">Textos, imagens, fontes e designs de outros apps.</span>
      </div>
      <div style="display:flex; align-items:center; gap:4px; padding:5px; border-radius:10px; border:1px solid var(--border); background:var(--surface); align-self:flex-start;">${impTabs}</div>
      ${body}
    </div>
    ${textModal}
    ${appModal}`;
}

function renderKeys(): string {
  const s = state;
  const rows = s.keys.map((k) => `
    <div style="display:grid; grid-template-columns:0.9fr 2.4fr 0.7fr 0.7fr 92px; gap:16px; padding:13px 16px; border-bottom:1px solid var(--surface-2); align-items:center; font-size:12px;">
      <span style="color:var(--text);">${esc(k.name)}</span>
      <div style="display:flex; align-items:center; gap:8px; min-width:0;">
        <span style="flex:1; min-width:0; font-family:var(--mono); font-size:11px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(k.revealed ? k.secret : k.secret.slice(0, 8) + "••••••••••••")}</span>
        <div data-action="toggle-key" data-id="${k.id}" style="cursor:pointer; flex:none; height:22px; padding:0 7px; border-radius:5px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; font-size:10px; color:var(--muted);">${k.revealed ? "Hide" : "Reveal"}</div>
        <div data-action="copy-key" data-id="${k.id}" style="cursor:pointer; flex:none; height:22px; padding:0 7px; border-radius:5px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; font-size:10px; color:var(--muted);">${s.copied === k.id ? "Copied" : "Copy"}</div>
      </div>
      <span style="color:var(--faint);">${esc(k.created)}</span>
      <span style="color:var(--faint);">${esc(k.lastUsed)}</span>
      <div data-action="revoke-key" data-id="${k.id}" style="cursor:pointer; justify-self:end; height:26px; padding:0 10px; border-radius:6px; border:1px solid var(--border); background:var(--surface-2); display:flex; align-items:center; font-size:11px; color:var(--danger);">Revoke</div>
    </div>`).join("");

  return `
    <div style="flex:1; display:flex; flex-direction:column; gap:16px; padding:20px; min-height:0;">
      <div style="display:flex; align-items:center; gap:16px;">
        <div style="display:flex; flex-direction:column; gap:5px;">
          <span style="font-family:var(--display); font-size:15px; font-weight:600;">API keys</span>
          <span style="font-size:12px; color:var(--faint);">${s.keys.length}${s.keys.length === 1 ? " key" : " keys"} · rotate every 90 days</span>
        </div>
        <div style="flex:1;"></div>
        <div data-action="create-key" style="cursor:pointer; height:32px; padding:0 14px; border-radius:7px; background:var(--accent); color:#111111; display:flex; align-items:center; gap:7px; font-size:12px; font-weight:500;">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3.2v9.6"></path><path d="M3.2 8h9.6"></path></svg>
          <span>Create key</span>
        </div>
      </div>

      <div style="border-radius:7px; border:1px solid var(--border); background:var(--surface); overflow:hidden;">
        <div style="display:grid; grid-template-columns:0.9fr 2.4fr 0.7fr 0.7fr 92px; gap:16px; padding:11px 16px; border-bottom:1px solid var(--border); background:var(--surface-2); font-size:11px; letter-spacing:0.04em; text-transform:uppercase; color:var(--faint);">
          <span>Name</span><span>Key</span><span>Created</span><span>Last used</span><span></span>
        </div>
        ${rows}
        ${s.keys.length === 0 ? `<div style="padding:40px; text-align:center; font-family:var(--mono); font-size:12px; color:var(--faint);">no keys — create one to start</div>` : ""}
      </div>

      <div style="border-radius:7px; border:1px dashed var(--border); padding:14px 16px; display:flex; gap:12px; align-items:flex-start;">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--faint)" stroke-width="1.3" stroke-linecap="round" style="flex:none; margin-top:1px;"><circle cx="8" cy="8" r="6.2"></circle><path d="M8 7.2v4"></path><path d="M8 4.9v.1"></path></svg>
        <span style="font-size:12px; line-height:1.6; color:var(--faint); max-width:620px;">Keys are shown once at creation. Revoking takes effect immediately across all environments.</span>
      </div>
    </div>`;
}

function render() {
  const s = state;
  const main =
    s.view === "templates" ? renderTemplates() :
    s.view === "playground" ? renderPlayground() :
    s.view === "import" ? renderImport() :
    renderKeys();

  root.innerHTML = `
    <div style="min-height:100vh; display:flex; flex-direction:column; background:var(--bg); color:var(--text); font-family:var(--body); font-size:13px;">
      <div style="flex:1; display:flex; min-height:0;">
        ${renderSidebar()}
        <main style="flex:1; min-width:0; display:flex; flex-direction:column;">${main}</main>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------------- */

function bind() {
  if (bound) return;
  bound = true;

  window.addEventListener("hashchange", () => {
    const view = viewFromHash();
    if (view !== state.view) { state.view = view; render(); }
  });

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const el = target.closest<HTMLElement>("[data-action]");
    if (!el) return;
    // Modal cards carry data-action only on their real buttons, not on the
    // card itself — so a click on blank card padding has no matching
    // ancestor until it reaches the backdrop's own close action. Block that:
    // only fire when the matched element is inside the card (or IS the
    // backdrop, i.e. no card boundary was crossed at all).
    const stopBoundary = target.closest<HTMLElement>("[data-stop]");
    if (stopBoundary && !stopBoundary.contains(el)) return;
    const action = el.dataset.action!;
    const id = el.dataset.id ? Number(el.dataset.id) : null;
    const value = el.dataset.value;

    switch (action) {
      case "go-templates": goToView("templates"); break;
      case "go-playground": goToView("playground"); break;
      case "go-import": goToView("import"); break;
      case "go-keys": goToView("keys"); break;
      case "toggle-aside": state.collapsed = !state.collapsed; render(); break;
      case "open-editor": navigate("editor"); break;
      case "open-twitter-template": openTweetTemplate(); navigate("editor"); break;

      case "pick-sort": state.sort = value!; render(); break;
      case "pick-period": state.period = value!; render(); break;

      case "add-text": addLayer("text"); break;
      case "add-image": addLayer("image"); break;
      case "remove-layer": state.layers = state.layers.filter((l) => l.id !== id); render(); break;
      case "render": startRender(); break;
      case "show-preview": state.tab = "preview"; render(); break;
      case "show-response": state.tab = "response"; render(); break;
      case "copy-code":
        navigator.clipboard?.writeText(snippetFor(state.lang)).catch(() => {});
        state.copiedCode = true; render();
        clearTimeout(copyCodeTimer);
        copyCodeTimer = setTimeout(() => { state.copiedCode = false; render(); }, 1200);
        break;

      case "pick-imp-Texto": state.impTab = "Texto"; render(); break;
      case "pick-imp-Imagens": state.impTab = "Imagens"; render(); break;
      case "pick-imp-Fontes": state.impTab = "Fontes"; render(); break;
      case "pick-imp-Apps": state.impTab = "Apps"; render(); break;
      case "open-text-modal": state.textModalOpen = true; render(); break;
      case "close-text-modal": state.textModalOpen = false; render(); break;
      case "import-text": {
        const raw = state.textDraft.trim();
        const blocks = raw ? raw.split(/\n\s*={3,}\s*\n|\n(?=\s*(?:bloco|tweet|post)\s*#\d+)/i).map((x) => x.trim()).filter(Boolean).length : 0;
        if (!blocks) break;
        state.textModalOpen = false;
        state.lastAdded = `texto · ${blocks}${blocks === 1 ? " bloco" : " blocos"}`;
        render();
        break;
      }
      case "add-from-url": {
        const u = state.importUrl.trim();
        if (!u) break;
        state.importUrl = "";
        state.lastAdded = "link · " + (u.split("/").pop() || u);
        render();
        break;
      }
      case "add-from-file": state.lastAdded = "arquivo local · aguardando upload"; render(); break;
      case "open-app-Canva": state.app = "Canva"; state.appUrl = ""; state.appDoc = null; render(); break;
      case "open-app-Figma": state.app = "Figma"; state.appUrl = ""; state.appDoc = null; render(); break;
      case "close-app": state.app = null; render(); break;
      case "confirm-app":
        state.lastAdded = `${state.app} · ${state.appDoc || state.appUrl || "importação iniciada"}`;
        state.app = null;
        render();
        break;
      case "pick-app-doc": state.appDoc = value!; render(); break;

      case "create-key": createKey(); break;
      case "toggle-key":
        state.keys = state.keys.map((k) => (k.id === id ? { ...k, revealed: !k.revealed } : k));
        render();
        break;
      case "copy-key": {
        const k = state.keys.find((x) => x.id === id);
        if (k) navigator.clipboard?.writeText(k.secret).catch(() => {});
        state.copied = id; render();
        clearTimeout(copyKeyTimer);
        copyKeyTimer = setTimeout(() => { state.copied = null; render(); }, 1200);
        break;
      }
      case "revoke-key": state.keys = state.keys.filter((k) => k.id !== id); render(); break;

      default:
        if (action.startsWith("pick-lang-")) { state.lang = action.slice("pick-lang-".length) as State["lang"]; render(); }
    }
  });

  root.addEventListener("input", (ev) => {
    const t = ev.target as HTMLInputElement | HTMLTextAreaElement;

    const layerId = (t as HTMLElement).dataset.layerValue;
    if (layerId) {
      const layer = state.layers.find((l) => String(l.id) === layerId);
      if (layer) { layer.value = t.value; patchSnippetLive(); }
      return;
    }

    const field = (t as HTMLElement).dataset.field as keyof State | undefined;
    if (field === "apiKey") { state.apiKey = t.value; patchSnippetLive(); return; }
    if (field === "importUrl") { state.importUrl = t.value; return; }
    if (field === "appUrl") { state.appUrl = t.value; return; }
    if (field === "textDraft") {
      state.textDraft = t.value;
      const raw = t.value.trim();
      const words = raw ? raw.split(/\s+/).length : 0;
      const blocks = raw ? raw.split(/\n\s*={3,}\s*\n|\n(?=\s*(?:bloco|tweet|post)\s*#\d+)/i).map((x) => x.trim()).filter(Boolean).length : 0;
      const stats = `${blocks}${blocks === 1 ? " bloco" : " blocos"} · ${words} palavras`;
      document.getElementById("textStatsA")?.replaceChildren(document.createTextNode(stats));
      document.getElementById("textStatsB")?.replaceChildren(document.createTextNode(stats));
      const label = document.getElementById("importTextLabel");
      if (label) label.textContent = `Importar ${blocks}${blocks === 1 ? " bloco" : " blocos"}`;
      const btn = document.getElementById("importTextBtn");
      if (btn) btn.style.opacity = blocks ? "1" : "0.45";
    }
  });

  root.addEventListener("change", (ev) => {
    const t = ev.target as HTMLSelectElement;
    const sel = t.dataset.select;
    if (!sel) return;
    if (sel === "template") { state.template = t.value; state.rendered = false; state.response = null; }
    else if (sel === "format") state.format = t.value;
    else if (sel === "page") state.page = t.value;
    else if (sel === "scope") state.scope = t.value;
    render();
  });
}

export function mountConsole(container: HTMLElement) {
  root = container;
  bind();
  state.view = viewFromHash();
  // Canonicalize a bare "#/console" (or a stale/unknown sub-route) to the view actually shown,
  // so the address bar, refresh, and back/forward all agree with what's on screen.
  if (location.hash.startsWith("#/console") && location.hash !== `#/console/${state.view}`) {
    history.replaceState(null, "", `#/console/${state.view}`);
  }
  render();
}
