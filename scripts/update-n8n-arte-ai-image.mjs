// Desacopla o workflow "Gerar Arte" do blank-editor: em vez de montar um design
// no Blank e renderizar via template, a IA (Gemini image-gen) gera a arte de
// cada card já com o texto embutido, e o PNG resultante vai direto pro Storage
// do Supabase. Nenhuma chamada ao blank-editor permanece no workflow.
import { randomUUID } from "node:crypto";

const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || "UwjV9qvUkowgory0";
const N8N_ORIGIN = process.env.N8N_ORIGIN || "https://n8n.srv909496.hstgr.cloud";
const SUPABASE_ORIGIN = process.env.SUPABASE_ORIGIN || "https://sites-blank-editor-supabase.ickanz.easypanel.host";
const SMOKE_BRIEFING_ID = process.env.SMOKE_BRIEFING_ID;

const automationEnv = await (await import("node:fs/promises")).readFile(new URL("../.env.automation", import.meta.url), "utf8");
const n8nApiKey = automationEnv.match(/^api\s+-\s+(.+)$/m)?.[1]?.trim();
const webhookHeaderValue = automationEnv.match(/^N8N_ARTE_WEBHOOK_SECRET=(.+)$/m)?.[1]?.trim();
if (!n8nApiKey) throw new Error("API key do n8n não encontrada em .env.automation");
if (!webhookHeaderValue) throw new Error("N8N_ARTE_WEBHOOK_SECRET não encontrado em .env.automation");

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

function codeNode(name, position, jsCode, mode) {
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: mode ? { mode, jsCode } : { jsCode },
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
    credentials: credentialType ? { [credentialType]: { id: credential.id, name: credential.name } } : undefined,
  };
}

const OPENAI_CREDENTIAL = { id: "KT9pM9kHS6XKy9U3", name: "Blank API" };
const SUPABASE_CREDENTIAL = { id: "fJQ7ez6wS5lODZwA", name: "Supabase | Blank Editor" };

const normalizeCode = [
  "// Entrada: topic_id ou briefing_id. blank_template_id nao e mais usado.",
  "const b = $input.first().json.body || $input.first().json;",
  "if (!b.topic_id && !b.briefing_id) throw new Error('payload precisa de topic_id ou briefing_id');",
  "return [{ json: {",
  "  topic_id: b.topic_id || null,",
  "  briefing_id: b.briefing_id || null,",
  "  publico_alvo: b.publico_alvo || 'Fundadores e executivos brasileiros',",
  "  origem: b.origem || 'manual',",
  "  run_id: b.run_id ? String(b.run_id) : null,",
  "  precisa_briefing: !b.briefing_id,",
  "} }];",
].join("\n");

const promptsCode = [
  "// Um item por card do roteiro: cada um vira uma chamada de imagem separada.",
  "const entrada = $('Normalizar entrada').first().json;",
  "const briefing = $('Carregar briefing').first().json;",
  "const roteiro = Array.isArray(briefing.roteiro) ? briefing.roteiro : [];",
  "if (roteiro.length < 1 || roteiro.length > 20) throw new Error('roteiro precisa ter de 1 a 20 cards');",
  "const total = roteiro.length;",
  "const effectiveRunId = entrada.run_id || ('n8n-' + $execution.id);",
  "",
  "return roteiro.map((rawCard, index) => {",
  "  const page = index + 1;",
  "  const isLast = index === total - 1;",
  "  // Briefings antigos guardam o roteiro como array de strings; os novos, como objetos.",
  "  const legado = typeof rawCard === 'string' ? rawCard : '';",
  "  const titulo = legado ? legado.slice(0, 60) : String(rawCard.titulo || '');",
  "  const corpo = legado || String(rawCard.corpo || '');",
  "  const card = { titulo, corpo };",
  "  const linhas = [",
  "    'Crie uma arte de carrossel para Instagram, estilo editorial brasileiro, moderno e sobrio.',",
  "    'Formato retrato, proporcao aproximada 4:5.',",
  "    `Tema geral: ${briefing.titulo}${briefing.angulo ? ' — ' + briefing.angulo : ''}.`,",
  "    `Este e o card ${page} de ${total}.`,",
  "    'O texto abaixo PRECISA aparecer escrito na imagem, legivel, bem posicionado, sem cortar palavras:',",
  "    `Titulo: \"${card.titulo}\"`,",
  "    `Corpo: \"${card.corpo}\"`,",
  "  ];",
  "  if (isLast && briefing.cta) linhas.push(`Chamada para acao no rodape: \"${briefing.cta}\"`);",
  "  linhas.push(`Numeracao discreta no canto: \"${page}/${total}\".`);",
  "  linhas.push('Direcao visual: fundo profissional relacionado ao tema, tipografia limpa e alto contraste, sem marca dagua, sem logos inventados, sem elementos genericos de banco de imagem.');",
  "  const imagePrompt = linhas.join('\\n');",
  "  const storagePath = `${effectiveRunId}/page-${page}.png`;",
  "  return { json: {",
  "    briefing_id: briefing.id,",
  "    run_id: effectiveRunId,",
  "    page,",
  "    total,",
  "    titulo: card.titulo,",
  "    corpo: card.corpo,",
  "    storage_path: storagePath,",
  "    png_url: `${" + JSON.stringify(SUPABASE_ORIGIN) + "}/storage/v1/object/public/intel-renders/${storagePath}`,",
  "    payload: { model: 'gpt-image-2', prompt: imagePrompt, size: '1024x1536', quality: 'medium' },",
  "  } };",
  "});",
].join("\n");

const extractImageCode = [
  "const meta = $('Montar prompts de imagem').item.json;",
  "const resp = $json;",
  "const b64 = resp?.data?.[0]?.b64_json;",
  "if (!b64) throw new Error('OpenAI nao retornou imagem para a pagina ' + meta.page + ': ' + JSON.stringify(resp).slice(0, 500));",
  "const buffer = Buffer.from(b64, 'base64');",
  "return { json: meta, binary: { data: await this.helpers.prepareBinaryData(buffer, `page-${meta.page}.png`, 'image/png') } };",
].join("\n");

const prepareRowCode = [
  "const meta = $('Extrair imagem').item.json;",
  "return { json: {",
  "  briefing_id: meta.briefing_id,",
  "  page: meta.page,",
  "  layers: { titulo: meta.titulo, corpo: meta.corpo },",
  "  status: 'REVISAR',",
  "  run_id: meta.run_id,",
  "  png_url: meta.png_url,",
  "} };",
].join("\n");

const aggregateCode = [
  "const rows = $input.all().map((item) => item.json);",
  "const first = rows[0];",
  "return [{ json: { rows, briefing_id: first?.briefing_id ?? null, run_id: first?.run_id ?? null, page_count: rows.length } }];",
].join("\n");

const responseCode = [
  "const generated = $('Agregar linhas').first().json;",
  "return [{ json: {",
  "  ok: true,",
  "  briefing_id: generated.briefing_id,",
  "  run_id: generated.run_id,",
  "  page_count: generated.page_count,",
  "  pages: generated.rows.map((row) => ({ page: row.page, png_url: row.png_url })),",
  "} }];",
].join("\n");

const original = await n8n(`/workflows/${WORKFLOW_ID}`);
const originalPayload = updatePayload(original);

const dropNames = new Set([
  "Montar paginas Blank", "Criar design no Blank", "Preparar art_renders Blank",
  "Gravar art_renders Blank", "Montar resposta Blank",
]);
const keptNodes = original.nodes.filter((node) => !dropNames.has(node.name)).map((node) => {
  if (node.name === "Normalizar entrada") {
    const copy = structuredClone(node);
    copy.parameters.jsCode = normalizeCode;
    return copy;
  }
  return node;
});

const newNodes = [
  codeNode("Montar prompts de imagem", [1540, 304], promptsCode),
  httpNode("OpenAI imagem", [1760, 304], {
    method: "POST",
    url: "=https://api.openai.com/v1/images/generations",
    authentication: "predefinedCredentialType",
    nodeCredentialType: "openAiApi",
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.payload) }}",
    options: { timeout: 120000 },
  }, "openAiApi", OPENAI_CREDENTIAL),
  codeNode("Extrair imagem", [1980, 304], extractImageCode, "runOnceForEachItem"),
  httpNode("Upload imagem Supabase", [2200, 304], {
    method: "POST",
    url: `=${SUPABASE_ORIGIN}/storage/v1/object/intel-renders/{{ $json.storage_path }}`,
    authentication: "predefinedCredentialType",
    nodeCredentialType: "supabaseApi",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "x-upsert", value: "true" }] },
    sendBody: true,
    contentType: "binaryData",
    inputDataFieldName: "data",
    options: { timeout: 60000 },
  }, "supabaseApi", SUPABASE_CREDENTIAL),
  codeNode("Preparar linha art_renders", [2420, 304], prepareRowCode, "runOnceForEachItem"),
  codeNode("Agregar linhas", [2640, 304], aggregateCode),
  httpNode("Gravar art_renders", [2860, 304], {
    method: "POST",
    url: `${SUPABASE_ORIGIN}/rest/v1/art_renders`,
    authentication: "predefinedCredentialType",
    nodeCredentialType: "supabaseApi",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: "Accept-Profile", value: "intel" },
      { name: "Content-Profile", value: "intel" },
      { name: "Prefer", value: "return=representation" },
    ] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.rows) }}",
    options: { timeout: 60000 },
  }, "supabaseApi", SUPABASE_CREDENTIAL),
  codeNode("Montar resposta", [3080, 304], responseCode),
];

const revisedNodes = [...keptNodes, ...newNodes];

const revisedConnections = structuredClone(original.connections);
for (const name of dropNames) delete revisedConnections[name];
revisedConnections["Carregar briefing"] = { main: [[{ node: "Montar prompts de imagem", type: "main", index: 0 }]] };
revisedConnections["Montar prompts de imagem"] = { main: [[{ node: "OpenAI imagem", type: "main", index: 0 }]] };
revisedConnections["OpenAI imagem"] = { main: [[{ node: "Extrair imagem", type: "main", index: 0 }]] };
revisedConnections["Extrair imagem"] = { main: [[{ node: "Upload imagem Supabase", type: "main", index: 0 }]] };
revisedConnections["Upload imagem Supabase"] = { main: [[{ node: "Preparar linha art_renders", type: "main", index: 0 }]] };
revisedConnections["Preparar linha art_renders"] = { main: [[{ node: "Agregar linhas", type: "main", index: 0 }]] };
revisedConnections["Agregar linhas"] = { main: [[{ node: "Gravar art_renders", type: "main", index: 0 }]] };
revisedConnections["Gravar art_renders"] = { main: [[{ node: "Montar resposta", type: "main", index: 0 }]] };
revisedConnections["Montar resposta"] = { main: [[{ node: "Responder", type: "main", index: 0 }]] };

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

  let smoke = null;
  if (SMOKE_BRIEFING_ID) {
    const webhookUrl = `${N8N_ORIGIN}/webhook/intel/arte`;
    const runId = randomUUID();
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blank-automation-key": webhookHeaderValue },
      body: JSON.stringify({ briefing_id: SMOKE_BRIEFING_ID, run_id: runId }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`webhook ${response.status}: ${String(text).slice(0, 800)}`);
    if (!body?.ok || !Array.isArray(body.pages) || body.pages.length === 0) {
      throw new Error(`smoke test inválido: ${JSON.stringify(body).slice(0, 800)}`);
    }
    smoke = body;
  }

  console.log(JSON.stringify({
    workflowId: WORKFLOW_ID,
    active: true,
    nodeCount: revisedNodes.length,
    smoke,
  }, null, 2));
} catch (error) {
  if (revisedWasActivated) {
    try { await n8n(`/workflows/${WORKFLOW_ID}/deactivate`, { method: "POST" }); } catch {}
  }
  await n8n(`/workflows/${WORKFLOW_ID}`, { method: "PUT", body: JSON.stringify(originalPayload) });
  if (original.active) await n8n(`/workflows/${WORKFLOW_ID}/activate`, { method: "POST" });
  throw error;
}
