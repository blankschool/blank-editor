import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || "UwjV9qvUkowgory0";
const N8N_ORIGIN = process.env.N8N_ORIGIN || "https://n8n.srv909496.hstgr.cloud";
const BLANK_ORIGIN = process.env.BLANK_ORIGIN || "https://blank-editor.ickanz.easypanel.host";
const SUPABASE_ORIGIN = process.env.SUPABASE_ORIGIN || "https://sites-blank-editor-supabase.ickanz.easypanel.host";
const TEMPLATE_ID = process.env.BLANK_AUTOMATION_TEMPLATE_ID;
const SMOKE_BRIEFING_ID = process.env.SMOKE_BRIEFING_ID;

if (!TEMPLATE_ID || !SMOKE_BRIEFING_ID) {
  throw new Error("defina BLANK_AUTOMATION_TEMPLATE_ID e SMOKE_BRIEFING_ID");
}

const automationEnv = await readFile(new URL("../.env.automation", import.meta.url), "utf8");
const n8nApiKey = automationEnv.match(/^api\s+-\s+(.+)$/m)?.[1]?.trim();
const savedWebhookSecret = automationEnv.match(/^N8N_ARTE_WEBHOOK_SECRET=(.+)$/m)?.[1]?.trim();
if (!n8nApiKey) throw new Error("API key do n8n não encontrada em .env.automation");

const apiOrigin = `${N8N_ORIGIN}/api/v1`;
const apiHeaders = { "X-N8N-API-KEY": n8nApiKey, "Content-Type": "application/json" };

async function n8n(path, init = {}) {
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    headers: { ...apiHeaders, ...init.headers },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    throw new Error(`n8n ${init.method || "GET"} ${path}: ${response.status} ${String(text).slice(0, 300)}`);
  }
  return body;
}

function updatePayload(workflow) {
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || {},
  };
}

async function listCredentials() {
  const body = await n8n("/credentials");
  return Array.isArray(body) ? body : body.data || [];
}

async function requiredCredential(credentials, name, type) {
  const found = credentials.find((credential) => credential.name === name && credential.type === type);
  if (!found) throw new Error(`credencial ausente no n8n: ${name} (${type})`);
  return found;
}

function withSupabaseCredential(node, credential) {
  const copy = structuredClone(node);
  const customHeaders = copy.parameters.headerParameters?.parameters || [];
  copy.parameters.authentication = "predefinedCredentialType";
  copy.parameters.nodeCredentialType = "supabaseApi";
  copy.parameters.headerParameters = {
    parameters: customHeaders.filter(({ name }) => !["apikey", "authorization"].includes(String(name).toLowerCase())),
  };
  copy.parameters.sendHeaders = copy.parameters.headerParameters.parameters.length > 0;
  copy.credentials = { supabaseApi: { id: credential.id, name: credential.name } };
  return copy;
}

function withGeminiCredential(node, credential) {
  const copy = structuredClone(node);
  copy.parameters.authentication = "genericCredentialType";
  copy.parameters.genericAuthType = "httpHeaderAuth";
  delete copy.parameters.headerParameters;
  delete copy.parameters.sendHeaders;
  copy.credentials = { httpHeaderAuth: { id: credential.id, name: credential.name } };
  return copy;
}

function codeNode(name, position, jsCode) {
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: { jsCode },
  };
}

function httpNode(name, position, parameters, credentialType, credential) {
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    parameters,
    credentials: { [credentialType]: { id: credential.id, name: credential.name } },
  };
}

const normalizeCode = [
  "// Entrada: topic_id ou briefing_id, sempre com blank_template_id.",
  "const b = $input.first().json.body || $input.first().json;",
  "if (!b.topic_id && !b.briefing_id) throw new Error('payload precisa de topic_id ou briefing_id');",
  "if (!b.blank_template_id) throw new Error('payload precisa de blank_template_id');",
  "return [{ json: {",
  "  topic_id: b.topic_id || null,",
  "  briefing_id: b.briefing_id || null,",
  "  blank_template_id: String(b.blank_template_id),",
  "  publico_alvo: b.publico_alvo || 'Fundadores e executivos brasileiros',",
  "  origem: b.origem || 'manual',",
  "  run_id: b.run_id || null,",
  "  precisa_briefing: !b.briefing_id,",
  "} }];",
].join("\n");

const pagesCode = [
  "// Um único payload para o Blank; a página-base é expandida pela API.",
  "const entrada = $('Normalizar entrada').first().json;",
  "const briefing = $('Carregar briefing').first().json;",
  "const roteiro = Array.isArray(briefing.roteiro) ? briefing.roteiro : [];",
  "if (roteiro.length < 1 || roteiro.length > 20) throw new Error('roteiro precisa ter de 1 a 20 cards');",
  "const total = roteiro.length;",
  "const pages = roteiro.map((card, index) => {",
  "  const legado = typeof card === 'string' ? card : '';",
  "  const titulo = legado ? legado.slice(0, 60) : String(card.titulo || '');",
  "  const corpo = legado || String(card.corpo || '');",
  "  return { layers: {",
  "  titulo: { text: titulo },",
  "  corpo: { text: corpo },",
  "  numero: { text: (index + 1) + '/' + total },",
  "  cta: { text: index === total - 1 ? String(briefing.cta || '') : '' },",
  "  } };",
  "});",
  "return [{ json: {",
  "  briefing_id: briefing.id,",
  "  blank_template_id: entrada.blank_template_id,",
  "  design_name: String(briefing.titulo || 'Arte do briefing'),",
  "  pages,",
  "  run_id: entrada.run_id,",
  "  idempotency_key: entrada.run_id || ('n8n-execution-' + $execution.id),",
  "} }];",
].join("\n");

const prepareRowsCode = [
  "const envelope = $input.first().json;",
  "const response = envelope.body || envelope;",
  "const design = response.design;",
  "const source = $('Montar paginas Blank').first().json;",
  "if (!design || !Array.isArray(design.pages)) throw new Error('Blank não devolveu design.pages');",
  `const editUrl = ${JSON.stringify(BLANK_ORIGIN)} + design.editorPath;`,
  "const rows = design.pages.map((render) => ({",
  "  briefing_id: source.briefing_id,",
  "  template_id: null,",
  "  blank_source_template_id: source.blank_template_id,",
  "  blank_design_id: design.id,",
  "  page: render.page,",
  "  layers: source.pages[render.page - 1].layers,",
  "  status: 'CONCLUIDO',",
  "  run_id: source.run_id,",
  "  edit_url: editUrl,",
  "  png_url: render.pngUrl,",
  "}));",
  "return [{ json: {",
  "  briefing_id: source.briefing_id,",
  "  design_id: design.id,",
  "  design_name: design.name,",
  "  page_count: design.pageCount,",
  "  edit_url: editUrl,",
  "  generation_state: Number(envelope.statusCode) === 200 ? 'replayed' : 'created',",
  "  rows,",
  "} }];",
].join("\n");

const responseCode = [
  "const generated = $('Preparar art_renders Blank').first().json;",
  "return [{ json: {",
  "  ok: true,",
  "  briefing_id: generated.briefing_id,",
  "  design_id: generated.design_id,",
  "  edit_url: generated.edit_url,",
  "  generation_state: generated.generation_state,",
  "  page_count: generated.page_count,",
  "  pages: generated.rows.map((row) => ({ page: row.page, png_url: row.png_url })),",
  "} }];",
].join("\n");

const original = await n8n(`/workflows/${WORKFLOW_ID}`);
const originalPayload = updatePayload(original);
const previousWebhookCredential = original.nodes
  .find((node) => node.name === "Webhook arte")?.credentials?.httpHeaderAuth;
const credentials = await listCredentials();
const blankCredential = await requiredCredential(credentials, "Blank Editor | n8n arte", "httpHeaderAuth");
const supabaseCredential = await requiredCredential(credentials, "Supabase | Blank Editor", "supabaseApi");
const geminiCredential = await requiredCredential(credentials, "Gemini Blank", "httpHeaderAuth");

const webhookHeaderName = "x-blank-automation-key";
const webhookHeaderValue = savedWebhookSecret || `it03_${randomBytes(32).toString("hex")}`;
const webhookCredential = await n8n("/credentials", {
  method: "POST",
  body: JSON.stringify({
    name: `Webhook | IT 03 Arte | ${new Date().toISOString().slice(0, 10)} | ${webhookHeaderValue.slice(-8)}`,
    type: "httpHeaderAuth",
    data: {
      name: webhookHeaderName,
      value: webhookHeaderValue,
      allowedHttpRequestDomains: "domains",
      allowedDomains: new URL(N8N_ORIGIN).hostname,
    },
  }),
});

const keep = new Set([
  "Webhook arte", "Normalizar entrada", "Precisa de briefing?", "Conteudos do topico",
  "Achatar conteudos", "Montar prompt do briefing", "Gemini briefing", "Validar briefing",
  "Gravar briefing", "Carregar briefing existente", "Carregar briefing", "Responder",
]);
const revisedNodes = original.nodes.filter((node) => keep.has(node.name)).map((node) => {
  if (["Conteudos do topico", "Gravar briefing", "Carregar briefing existente"].includes(node.name)) {
    return withSupabaseCredential(node, supabaseCredential);
  }
  if (node.name === "Gemini briefing") return withGeminiCredential(node, geminiCredential);
  const copy = structuredClone(node);
  if (copy.name === "Webhook arte") {
    copy.parameters.authentication = "headerAuth";
    copy.credentials = { httpHeaderAuth: { id: webhookCredential.id, name: webhookCredential.name } };
  }
  if (copy.name === "Normalizar entrada") copy.parameters.jsCode = normalizeCode;
  if (copy.name === "Responder") copy.position = [2640, 300];
  return copy;
});

revisedNodes.push(
  codeNode("Montar paginas Blank", [1540, 300], pagesCode),
  httpNode("Criar design no Blank", [1760, 300], {
    method: "POST",
    url: `${BLANK_ORIGIN}/api/v1/generations`,
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "Idempotency-Key", value: "={{ $json.idempotency_key }}" }] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ template: $json.blank_template_id, name: $json.design_name, pages: $json.pages }) }}",
    options: { timeout: 120000, response: { response: { fullResponse: true } } },
  }, "httpHeaderAuth", blankCredential),
  codeNode("Preparar art_renders Blank", [1980, 300], prepareRowsCode),
  httpNode("Gravar art_renders Blank", [2200, 300], {
    method: "POST",
    url: `${SUPABASE_ORIGIN}/rest/v1/art_renders?on_conflict=blank_design_id,page`,
    authentication: "predefinedCredentialType",
    nodeCredentialType: "supabaseApi",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: "Accept-Profile", value: "intel" },
      { name: "Content-Profile", value: "intel" },
      { name: "Prefer", value: "resolution=merge-duplicates,return=representation" },
    ] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.rows) }}",
    options: { timeout: 120000 },
  }, "supabaseApi", supabaseCredential),
  codeNode("Montar resposta Blank", [2420, 300], responseCode),
);

const revisedConnections = {
  "Webhook arte": { main: [[{ node: "Normalizar entrada", type: "main", index: 0 }]] },
  "Normalizar entrada": { main: [[{ node: "Precisa de briefing?", type: "main", index: 0 }]] },
  "Precisa de briefing?": { main: [
    [{ node: "Conteudos do topico", type: "main", index: 0 }],
    [{ node: "Carregar briefing existente", type: "main", index: 0 }],
  ] },
  "Conteudos do topico": { main: [[{ node: "Achatar conteudos", type: "main", index: 0 }]] },
  "Achatar conteudos": { main: [[{ node: "Montar prompt do briefing", type: "main", index: 0 }]] },
  "Montar prompt do briefing": { main: [[{ node: "Gemini briefing", type: "main", index: 0 }]] },
  "Gemini briefing": { main: [[{ node: "Validar briefing", type: "main", index: 0 }]] },
  "Validar briefing": { main: [[{ node: "Gravar briefing", type: "main", index: 0 }]] },
  "Gravar briefing": { main: [[{ node: "Carregar briefing", type: "main", index: 0 }]] },
  "Carregar briefing existente": { main: [[{ node: "Carregar briefing", type: "main", index: 1 }]] },
  "Carregar briefing": { main: [[{ node: "Montar paginas Blank", type: "main", index: 0 }]] },
  "Montar paginas Blank": { main: [[{ node: "Criar design no Blank", type: "main", index: 0 }]] },
  "Criar design no Blank": { main: [[{ node: "Preparar art_renders Blank", type: "main", index: 0 }]] },
  "Preparar art_renders Blank": { main: [[{ node: "Gravar art_renders Blank", type: "main", index: 0 }]] },
  "Gravar art_renders Blank": { main: [[{ node: "Montar resposta Blank", type: "main", index: 0 }]] },
  "Montar resposta Blank": { main: [[{ node: "Responder", type: "main", index: 0 }]] },
};

const revisedPayload = {
  name: original.name,
  nodes: revisedNodes,
  connections: revisedConnections,
  settings: original.settings || {},
};

let revisedWasActivated = false;
try {
  if (original.active) await n8n(`/workflows/${WORKFLOW_ID}/deactivate`, { method: "POST" });
  await n8n(`/workflows/${WORKFLOW_ID}`, { method: "PUT", body: JSON.stringify(revisedPayload) });
  await n8n(`/workflows/${WORKFLOW_ID}/activate`, { method: "POST" });
  revisedWasActivated = true;

  const runId = randomUUID();
  const webhookUrl = `${N8N_ORIGIN}/webhook/intel/arte`;
  const payload = { briefing_id: SMOKE_BRIEFING_ID, blank_template_id: TEMPLATE_ID, run_id: runId };
  const callWebhook = async () => {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", [webhookHeaderName]: webhookHeaderValue },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`webhook ${response.status}: ${String(text).slice(0, 500)}`);
    return body;
  };

  const first = await callWebhook();
  const second = await callWebhook();
  if (!first?.ok || !second?.ok || first.design_id !== second.design_id) {
    throw new Error(`smoke test inválido: ${JSON.stringify({ first, second }).slice(0, 1000)}`);
  }
  if (first.generation_state !== "created" || second.generation_state !== "replayed") {
    throw new Error(`idempotência inválida: ${first.generation_state}/${second.generation_state}`);
  }
  if (previousWebhookCredential?.id && previousWebhookCredential.id !== webhookCredential.id) {
    await n8n(`/credentials/${previousWebhookCredential.id}`, { method: "DELETE" });
  }

  console.log(JSON.stringify({
    workflowId: WORKFLOW_ID,
    active: true,
    nodeCount: revisedNodes.length,
    briefingId: first.briefing_id,
    designId: first.design_id,
    editUrl: first.edit_url,
    pageCount: first.page_count,
    firstState: first.generation_state,
    replayState: second.generation_state,
    runId,
  }));
} catch (error) {
  if (revisedWasActivated) {
    try { await n8n(`/workflows/${WORKFLOW_ID}/deactivate`, { method: "POST" }); } catch {}
  }
  await n8n(`/workflows/${WORKFLOW_ID}`, { method: "PUT", body: JSON.stringify(originalPayload) });
  if (original.active) await n8n(`/workflows/${WORKFLOW_ID}/activate`, { method: "POST" });
  throw error;
}
