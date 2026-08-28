// Edge Function da tela "Gerar" (fase 12 do plano de migração): recebe um tema + o id de um
// template que já existe (a tela sempre cria uma cópia em branco antes de chamar isto — nunca
// sobrescreve o modelo/design de origem), pede pra OpenAI escrever o texto de cada campo
// nomeado, e chama de volta o render do Fastify com `save:true` — o mesmo efeito de abrir o
// template no editor e salvar, só que disparado por aqui. Devolve o PNG de cada página em
// base64, pronto pra tela mostrar sem mais uma chamada.
//
// Autenticação: repassa o mesmo Authorization (JWT do Supabase de quem está logado) que chegou
// aqui pro Fastify — é a decisão tomada no planejamento: o render do Fastify aceita esse JWT
// como alternativa à chave de API Bearer, exatamente pra esse caminho (uma Edge Function agindo
// em nome de quem clicou "Gerar", sem guardar cópia da chave de API de ninguém).
import { encodeBase64 } from "jsr:@std/encoding/base64";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

interface TemplateElement {
  name?: string;
  type?: string;
}

interface TemplatePage {
  els?: TemplateElement[];
}

interface TemplateDocument {
  pages?: TemplatePage[];
}

interface PageSchema {
  page: number;
  fields: string[];
}

/** Só campos de texto — a IA escreve texto, nunca escolhe/gera foto (decisão do planejamento). */
function schemaFor(document: TemplateDocument): PageSchema[] {
  return (document.pages ?? []).map((page, i) => ({
    page: i + 1,
    fields: (page.els ?? [])
      .filter((el): el is TemplateElement & { name: string } => Boolean(el?.type === "text" && el.name))
      .map((el) => el.name),
  }));
}

function buildPrompt(theme: string, schema: PageSchema[]): string {
  const descricao = schema
    .map(({ page, fields }) => `Página ${page}: campos [${fields.join(", ")}]`)
    .join("\n");
  return (
    `Tema: "${theme}"\n\n` +
    `Escreva o texto de cada campo abaixo, para cada página, em português do Brasil, tom direto. ` +
    `Devolva só um objeto JSON: cada chave é o número da página (como string), cada valor é um ` +
    `objeto com uma chave por campo listado.\n\n${descricao}\n\n` +
    `Exemplo de formato (não copie o conteúdo, só a forma): {"1": {"titulo": "...", "subtitulo": "..."}}`
  );
}

async function callOpenAI(apiKey: string, prompt: string): Promise<Record<string, Record<string, string>>> {
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "Você escreve textos curtos para posts de redes sociais em português do Brasil. Responda só com JSON válido, sem comentários nem markdown.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.8,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content");
  return JSON.parse(content);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("authorization");
  if (!authHeader) return json({ error: "missing Authorization" }, 401);

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) return json({ error: "OPENAI_API_KEY is not configured" }, 500);
  const fastifyUrl = Deno.env.get("FASTIFY_URL") ?? "http://host.docker.internal:8787";

  let body: { templateId?: string; theme?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const { templateId, theme } = body;
  if (!templateId || !theme?.trim()) {
    return json({ error: "missing required field: templateId, theme" }, 400);
  }

  const tplRes = await fetch(`${fastifyUrl}/api/v1/templates/${templateId}`, {
    headers: { authorization: authHeader },
  });
  if (!tplRes.ok) {
    const errBody = await tplRes.json().catch(() => ({}));
    return json({ error: errBody.error ?? `template not found: ${templateId}` }, tplRes.status);
  }
  const tpl = await tplRes.json();
  const document = tpl.document as TemplateDocument;
  const schema = schemaFor(document);
  const totalFields = schema.reduce((n, p) => n + p.fields.length, 0);
  if (totalFields === 0) return json({ error: "this template has no named text fields for the AI to fill in" }, 400);

  let completion: Record<string, Record<string, string>>;
  try {
    completion = await callOpenAI(openaiKey, buildPrompt(theme, schema));
  } catch (err) {
    return json({ error: `OpenAI: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  const pages: Array<{ page: number; layers: Record<string, string>; imageBase64: string }> = [];
  const multiPage = schema.length > 1;

  for (const { page, fields } of schema) {
    const layers: Record<string, { text: string }> = {};
    const textValues: Record<string, string> = {};
    for (const field of fields) {
      const value = completion[String(page)]?.[field];
      if (typeof value === "string" && value.trim()) {
        layers[field] = { text: value };
        textValues[field] = value;
      }
    }

    const renderRes = await fetch(`${fastifyUrl}/api/v1/render`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ template: templateId, ...(multiPage ? { page } : {}), layers, save: true }),
    });
    if (!renderRes.ok) {
      const errBody = await renderRes.json().catch(() => ({}));
      return json({ error: `render failed on page ${page}: ${errBody.error ?? renderRes.statusText}` }, 400);
    }
    const pngBuffer = new Uint8Array(await renderRes.arrayBuffer());
    pages.push({ page, layers: textValues, imageBase64: encodeBase64(pngBuffer) });
  }

  return json({ templateId, pages });
});
