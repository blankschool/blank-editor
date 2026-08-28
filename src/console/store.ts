import { useSyncExternalStore } from "react";
import { openTemplateById } from "../editor";

/**
 * O estado e as ações do console, portados de src/pages/console.ts sem mudança
 * de comportamento: mesmos campos, mesmos fetches, mesma ordem de efeitos. O
 * que saiu foi só a camada de renderização (innerHTML + bind por data-action),
 * que virou React.
 *
 * O estado continua um objeto mutável de módulo em vez de useState/useReducer, e
 * isso é deliberado por dois motivos:
 *
 *  - Ele sobrevive à troca de aba. Antes, um render() completo pintava as
 *    quatro views a partir do mesmo `state`; a API key digitada, as camadas
 *    preenchidas e o preview gerado seguiam lá ao voltar do Templates para o
 *    Playground. Com estado por componente, cada view desmontada perderia isso.
 *  - As funções async (loadTemplates, startRender, createKey…) já eram corretas.
 *    Mantê-las intactas troca o risco de regressão por uma mudança de uma linha:
 *    render() → notify().
 *
 * React observa via useSyncExternalStore. O snapshot é o contador `version`, não
 * o estado: `state` é mutado no lugar, então sua identidade nunca muda e não
 * serviria como snapshot.
 */

export type View = "designs" | "account" | "playground" | "import" | "keys";
export const VIEWS: View[] = ["designs", "account", "playground", "import", "keys"];
const DEFAULT_VIEW: View = "designs";

/**
 * As três telas de desenvolvedor. Deixaram de ser item de menu — o menu antigo
 * tinha quatro entradas de peso igual (Templates / Playground / Importar /
 * Chaves), o que descrevia a API e não o produto. Agora vivem sob Conta, e a
 * navegação marca "Conta" como ativa enquanto qualquer uma delas está aberta.
 */
export const DEV_VIEWS: View[] = ["playground", "import", "keys"];

/** Rotas que existiam antes da reorganização, para link antigo e favorito não caírem em 404 silencioso. */
const VIEW_ALIASES: Record<string, View> = { templates: "designs" };

export type LayerType = "text" | "image";
export type Lang = "JavaScript" | "Python" | "cURL" | "PHP";
export type ImpTab = "JSON" | "Imagens" | "Fontes" | "Apps";
export type AppName = "Canva" | "Figma";

export interface Layer { id: number; type: LayerType; name: string; value: string; }
export interface ApiKey { id: string; name: string; createdAt: string; revoked: boolean; }
export interface TemplateSummary { id: string; name: string; updatedAt: string; }
export interface AppDoc { name: string; meta: string; }

export interface State {
  view: View;
  templateId: string;
  apiKey: string;
  layers: Layer[];
  collapsed: boolean;
  sort: string;
  period: string;
  impTab: ImpTab;
  importUrl: string;
  jsonModalOpen: boolean;
  lastAdded: string;
  app: AppName | null;
  appUrl: string;
  appDoc: string | null;
  tab: "preview" | "response";
  lang: Lang;
  rendering: boolean;
  rendered: boolean;
  response: string | null;
  previewUrl: string | null;
  copiedCode: boolean;
  copied: string | null;
  keys: ApiKey[];
  keysLoaded: boolean;
  newKeySecret: { id: string; secret: string } | null;
  templates: TemplateSummary[];
  templatesLoaded: boolean;
  jsonDraft: string;
  jsonError: string | null;
  namePrompt: { kind: "new-template" | "create-key" | "rename-template"; title: string; value: string; error: string | null; id?: string } | null;
  layersLoadedForId: string | null;
  search: string;
  confirmDialog: { kind: "delete-template"; id: string; name: string } | null;
  /**
   * Saúde da sincronização com a API, mostrada no header como "Tudo no ar" /
   * "Falhou ao sincronizar". Sai de requisição real — qualquer fetch do console
   * que falhe ou volte !ok marca "failed" — e não de um indicador decorativo.
   */
  sync: "ok" | "syncing" | "failed";
  /** Id do design cujo nome está sendo editado no próprio card. */
  renamingId: string | null;
}

export const state: State = {
  view: DEFAULT_VIEW,
  templateId: "",
  apiKey: "",
  layers: [],
  collapsed: false,
  sort: "Ordem",
  period: "Todos",
  impTab: "JSON",
  importUrl: "",
  jsonModalOpen: false,
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
  keys: [],
  keysLoaded: false,
  newKeySecret: null,
  templates: [],
  templatesLoaded: false,
  jsonDraft: "",
  jsonError: null,
  namePrompt: null,
  layersLoadedForId: null,
  search: "",
  confirmDialog: null,
  sync: "ok",
  renamingId: null,
};

/* ------------------------------ store ------------------------------ */

let version = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publica a mutação. Ocupa exatamente o lugar do antigo render(). */
export function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function useConsole(): State {
  useSyncExternalStore(subscribe, () => version, () => version);
  return state;
}

/** Atalho para `set` + notify em campos simples de formulário. */
export function set<K extends keyof State>(key: K, value: State[K]) {
  state[key] = value;
  notify();
}

/* --------------------------- constantes UI -------------------------- */

export const IMP_META: Record<string, { placeholder: string; accept: string }> = {
  Imagens: { placeholder: "https://cdn.exemplo.com/foto.png", accept: "png · jpg · webp · svg" },
  Fontes: { placeholder: "https://fonts.exemplo.com/familia.woff2", accept: "woff2 · woff · ttf · otf" },
};

export const APP_META: Record<AppName, { hint: string; placeholder: string; docs: AppDoc[] }> = {
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

export const JSON_PLACEHOLDER =
  '{\n  "name": "Meu template",\n  "pages": [\n    { "w": 1080, "h": 1350, "bg": "#000000", "els": [] }\n  ]\n}';

/* ------------------------------ rotas ------------------------------ */

/** Lê a sub-rota do próprio console em `#/console/<view>`, para refresh/voltar/link direto funcionarem. */
export function viewFromHash(): View {
  const match = /^#\/console\/([a-z]+)/.exec(location.hash);
  const candidate = match?.[1];
  if (!candidate) return DEFAULT_VIEW;
  if (VIEW_ALIASES[candidate]) return VIEW_ALIASES[candidate];
  return VIEWS.includes(candidate as View) ? (candidate as View) : DEFAULT_VIEW;
}

export function goToView(view: View) {
  location.hash = `/console/${view}`;
}

/**
 * Ponto de entrada do console: ao montar, a cada hashchange e a cada vez que o
 * router volta a mostrar a view (o `onShow` em main.tsx).
 *
 * Faz duas coisas que antes não aconteciam:
 *
 *  - Canonicaliza a URL sempre, não só na montagem. `#/console/templates` (rota
 *    antiga) resolvia para a view Designs mas a barra de endereço continuava
 *    mostrando a rota velha, e um F5 ali repetia a tradução para sempre.
 *  - Revalida ao reaparecer. Antes, criar um design ia para o editor e voltar
 *    não recarregava nada: o hashchange comparava a view (que não tinha mudado)
 *    e desistia, então o design novo simplesmente não estava em "Seus designs".
 *    Numa home que promete os últimos editados, isso é defeito, não detalhe.
 */
export function openConsole() {
  const view = viewFromHash();
  if (location.hash.startsWith("#/console") && location.hash !== `#/console/${view}`) {
    history.replaceState(null, "", `#/console/${view}`);
  }
  if (view !== state.view) {
    enterView(view);
    return;
  }
  // Mesma view: revalida o que pode ter mudado fora do console (o editor salva,
  // renomeia e cria). `templatesLoaded` false significa "alguém invalidou".
  if (!state.templatesLoaded) loadTemplates();
  else if (view === "designs") loadTemplates();
  notify();
}

export function enterView(view: View) {
  state.view = view;
  if (view === "keys" && !state.keysLoaded) loadKeys();
  // O playground escolhe da mesma lista, então também precisa dos designs carregados, não só a home.
  if ((view === "designs" || view === "playground") && !state.templatesLoaded) loadTemplates();
  if (view === "playground" && state.templateId && state.layersLoadedForId !== state.templateId) {
    loadLayersForTemplate(state.templateId);
  }
  notify();
}

/* --------------------------- snippet / render --------------------------- */

export function filledLayers(): Layer[] {
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

export function snippetFor(lang: Lang): string {
  const s = state;
  const jsonLayers = JSON.stringify(requestLayers());
  const key = s.apiKey || "SUA_API_KEY";
  const url = `${location.origin}/api/v1/render`;
  const tid = s.templateId;

  if (lang === "Python") {
    return `import requests\n\nr = requests.post(\n    "${url}",\n    headers={"Authorization": "Bearer ${key}"},\n    json={"template": "${tid}", "layers": ${jsonLayers}},\n)\nr.raise_for_status()\nopen("twitter.png", "wb").write(r.content)`;
  }
  if (lang === "cURL") {
    return `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '{"template":"${tid}","layers":${jsonLayers}}' \\\n  --output twitter.png`;
  }
  if (lang === "PHP") {
    return `$png = Http::withToken("${key}")\n    ->post("${url}", [\n        "template" => "${tid}",\n        "layers"   => $layers,\n    ])->throw()->body();\n\nfile_put_contents("twitter.png", $png);`;
  }
  return `const response = await fetch("${url}", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n    Authorization: "Bearer ${key}",\n  },\n  body: JSON.stringify({ template: "${tid}", layers: ${jsonLayers} }),\n});\n\nif (!response.ok) throw new Error(await response.text());\nconst png = await response.blob();`;
}

export async function startRender() {
  if (state.rendering) return;
  if (!state.apiKey.trim()) {
    state.tab = "response";
    state.response = JSON.stringify({ ok: false, error: "Cole uma API key primeiro (crie uma em Chaves de API)." }, null, 2);
    notify();
    return;
  }
  if (!state.templateId) {
    state.tab = "response";
    state.response = JSON.stringify({ ok: false, error: "Escolha um template primeiro (crie um em Templates)." }, null, 2);
    notify();
    return;
  }
  state.rendering = true; state.rendered = false; state.response = null;
  notify();
  const started = performance.now();
  try {
    const response = await fetch("/api/v1/render", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({
        template: state.templateId,
        layers: requestLayers(),
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
    notify();
  }
}

export function setLayerValue(id: number, value: string) {
  const layer = state.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.value = value;
  notify();
}

/* ---------------------------- templates ---------------------------- */

/**
 * Guarda de requisição em voo. O openConsole é chamado por dois caminhos no
 * boot — o onShow do router e o efeito de montagem do ConsoleApp — e sem isto
 * a lista era buscada duas vezes em toda abertura.
 */
let templatesInFlight: Promise<void> | null = null;

export function loadTemplates(): Promise<void> {
  templatesInFlight ??= fetchTemplates().finally(() => { templatesInFlight = null; });
  return templatesInFlight;
}

async function fetchTemplates() {
  state.templatesLoaded = true;
  state.sync = "syncing";
  notify();
  try {
    const res = await fetch("/api/v1/templates");
    if (res.ok) {
      state.templates = await res.json();
      state.sync = "ok";
    } else {
      state.sync = "failed";
    }
  } catch {
    // offline — mantém o que já estava carregado, mas diz que está desatualizado
    state.sync = "failed";
  }
  // O template selecionado no playground tem que existir de verdade — não há mais um default
  // fixo (um banco novo/de produção começa com zero templates).
  if (!state.templates.some((t) => t.id === state.templateId)) {
    state.templateId = state.templates[0]?.id ?? "";
    state.layersLoadedForId = null;
  }
  if (state.templateId && state.view === "playground") await loadLayersForTemplate(state.templateId);
  notify();
}

/** Os designs mexidos mais recentemente. O servidor já devolve ordenado por updatedAt desc (db.ts e local.ts), então é só cortar. */
export function recentTemplates(count = 3): TemplateSummary[] {
  return state.templates.slice(0, count);
}

/** Remonta os campos do playground a partir dos elementos text/image nomeados que o template realmente tem — template diferente tem campos diferentes, então não pode ser lista fixa. */
export async function loadLayersForTemplate(id: string) {
  state.layersLoadedForId = id; // antes do await, para reentrar na view durante o load não refetchar
  try {
    const res = await fetch(`/api/v1/templates/${id}`);
    if (!res.ok) return;
    const { document } = await res.json();
    const page = document?.pages?.[document?.active || 0];
    const els: Array<{ name?: string; type?: string; text?: string; src?: string }> = Array.isArray(page?.els) ? page.els : [];
    state.layers = els
      .filter((el): el is { name: string; type: string; text?: string; src?: string } => Boolean(el?.name) && (el?.type === "text" || el?.type === "image"))
      .map((el, i) => ({
        id: i + 1,
        type: el.type as LayerType,
        name: el.name,
        value: el.type === "image" ? (el.src?.startsWith("http") ? el.src : "") : el.text || "",
      }));
  } catch { /* offline — mantém os campos que já apareciam */ }
  notify();
}

export function selectTemplate(id: string) {
  state.templateId = id;
  state.rendered = false;
  state.response = null;
  loadLayersForTemplate(id);
  notify();
}

async function createNewTemplate(name: string): Promise<string | null> {
  const blank = { name, active: 0, pages: [{ id: "page-1", w: 1080, h: 1350, bg: "#000000", els: [] }] };
  const res = await fetch("/api/v1/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, document: blank }),
  });
  if (!res.ok) return "Não foi possível criar o design.";
  const { id } = await res.json();
  state.templatesLoaded = false; // força refetch na próxima vez que Templates abrir
  await openTemplateById(id); // também atualiza a URL para #/editor/<id>, que o router casa
  return null;
}

/** Valida um JSON colado/enviado o suficiente para tentar abrir — o editor é o juiz real de usabilidade. */
function parseTemplateJson(raw: string): { name: string; document: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = parsed as { name?: string; pages?: unknown[] } | null;
  if (!candidate || !Array.isArray(candidate.pages) || candidate.pages.length === 0) return null;
  return { name: candidate.name || "Design importado", document: candidate };
}

export async function importTemplateJson() {
  const parsed = parseTemplateJson(state.jsonDraft);
  if (!parsed) { state.jsonError = "JSON inválido — precisa ter um array \"pages\" com pelo menos uma página."; notify(); return; }
  state.jsonError = null;
  const res = await fetch("/api/v1/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed),
  });
  if (!res.ok) { state.jsonError = "O servidor recusou esse documento."; notify(); return; }
  const { id } = await res.json();
  state.templatesLoaded = false;
  state.jsonDraft = "";
  state.jsonModalOpen = false;
  state.lastAdded = `JSON importado como o design “${parsed.name}”.`;
  await openTemplateById(id); // também atualiza a URL para #/editor/<id>
}

export function startRenaming(id: string | null) {
  state.renamingId = id;
  notify();
}

/**
 * Renomear direto no card. Diferente do renameTemplate do modal: atualiza a
 * lista local na hora em vez de refetchar tudo, porque quem acabou de digitar o
 * nome não deve ver o card piscar de volta para o antigo antes de virar.
 */
export async function renameTemplateInline(id: string, name: string) {
  state.renamingId = null;
  const trimmed = name.trim();
  const current = state.templates.find((t) => t.id === id);
  if (!trimmed || !current || trimmed === current.name) { notify(); return; }
  state.templates = state.templates.map((t) => (t.id === id ? { ...t, name: trimmed } : t));
  notify();
  try {
    const res = await fetch(`/api/v1/templates/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) throw new Error(String(res.status));
    state.sync = "ok";
  } catch {
    // Reverte: o card não pode continuar mostrando um nome que o servidor recusou.
    state.templates = state.templates.map((t) => (t.id === id ? { ...t, name: current.name } : t));
    state.sync = "failed";
  }
  notify();
}

async function renameTemplate(id: string, name: string): Promise<string | null> {
  const res = await fetch(`/api/v1/templates/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return "Não foi possível renomear.";
  state.templatesLoaded = false;
  await loadTemplates();
  return null;
}

export async function duplicateTemplate(id: string, name: string) {
  const got = await fetch(`/api/v1/templates/${id}`);
  if (!got.ok) return;
  const { document } = await got.json();
  const res = await fetch("/api/v1/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `${name} (cópia)`, document }),
  });
  if (!res.ok) return;
  state.templatesLoaded = false;
  await loadTemplates();
}

export function askDeleteTemplate(id: string, name: string) {
  state.confirmDialog = { kind: "delete-template", id, name };
  notify();
}

export async function runConfirmDialog() {
  const d = state.confirmDialog;
  if (!d) return;
  state.confirmDialog = null;
  if (d.kind === "delete-template") {
    const res = await fetch(`/api/v1/templates/${d.id}`, { method: "DELETE" });
    if (res.ok) state.templates = state.templates.filter((t) => t.id !== d.id);
  }
  notify();
}

export { openTemplateById };

/* ------------------------------ chaves ------------------------------ */

export async function loadKeys() {
  state.keysLoaded = true; // antes do await, para um segundo notify durante o load não refetchar
  try {
    const res = await fetch("/api/v1/keys");
    if (res.ok) { state.keys = await res.json(); state.sync = "ok"; }
    else state.sync = "failed";
  } catch {
    // offline — o console segue mostrando o que já carregou, sinalizando que está velho
    state.sync = "failed";
  }
  notify();
}

async function createKey(name: string): Promise<string | null> {
  const res = await fetch("/api/v1/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return "Não foi possível criar a chave.";
  const created = await res.json();
  state.keys.unshift({ id: created.id, name: created.name, createdAt: created.createdAt, revoked: false });
  state.newKeySecret = { id: created.id, secret: created.secret };
  return null;
}

export async function revokeKey(id: string) {
  const res = await fetch(`/api/v1/keys/${id}`, { method: "DELETE" });
  if (!res.ok) return;
  state.keys = state.keys.map((k) => (k.id === id ? { ...k, revoked: true } : k));
  if (state.newKeySecret?.id === id) state.newKeySecret = null;
  notify();
}

/** Remove de vez uma chave já revogada — o servidor recusa purgar uma chave viva. */
export async function purgeKey(id: string) {
  const res = await fetch(`/api/v1/keys/${id}/purge`, { method: "DELETE" });
  if (!res.ok) return;
  state.keys = state.keys.filter((k) => k.id !== id);
  notify();
}

/* --------------------------- name prompt --------------------------- */

/**
 * Abre o modal de nome compartilhado. Continua sendo um diálogo do app, não
 * window.prompt() — esse pode ser bloqueado em silêncio (bloqueadores de popup,
 * webviews embarcadas), sem nenhum feedback visível.
 */
export function openNamePrompt(
  kind: NonNullable<State["namePrompt"]>["kind"],
  title: string,
  opts: { id?: string; value?: string } = {},
) {
  state.namePrompt = { kind, title, value: opts.value ?? "", error: null, id: opts.id };
  notify();
}

export function setNamePromptValue(value: string) {
  if (!state.namePrompt) return;
  state.namePrompt.value = value;
  notify();
}

export function closeNamePrompt() {
  state.namePrompt = null;
  notify();
}

export async function confirmNamePrompt() {
  const p = state.namePrompt;
  if (!p || !p.value.trim()) return;
  const name = p.value.trim();
  let error: string | null;
  if (p.kind === "new-template") error = await createNewTemplate(name);
  else if (p.kind === "create-key") error = await createKey(name);
  else error = await renameTemplate(p.id!, name);
  if (error) { if (state.namePrompt) state.namePrompt.error = error; notify(); return; }
  state.namePrompt = null;
  notify();
}

/* ------------------------------ copiar ------------------------------ */

let copyKeyTimer: ReturnType<typeof setTimeout> | undefined;
let copyCodeTimer: ReturnType<typeof setTimeout> | undefined;

export function copyCode() {
  navigator.clipboard?.writeText(snippetFor(state.lang)).catch(() => {});
  state.copiedCode = true;
  notify();
  clearTimeout(copyCodeTimer);
  copyCodeTimer = setTimeout(() => { state.copiedCode = false; notify(); }, 1200);
}

export function copyText(text: string, marker: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
  state.copied = marker;
  notify();
  clearTimeout(copyKeyTimer);
  copyKeyTimer = setTimeout(() => { state.copied = null; notify(); }, 1200);
}
