// Edge Function da tela "Gerar" (fase 12 do plano de migração): recebe um tema + o id de um
// template que já existe, pede pra OpenAI escrever texto e briefings visuais e então chama
// POST /generations. O Fastify cria uma cópia editável, adquire cada imagem de forma explícita
// (Pexels ou OpenAI), guarda os bytes no Storage e devolve previews privados para aprovação.
//
// Autenticação: repassa o mesmo Authorization (JWT do Supabase de quem está logado) que chegou
// aqui pro Fastify — é a decisão tomada no planejamento: o render do Fastify aceita esse JWT
// como alternativa à chave de API Bearer, exatamente pra esse caminho (uma Edge Function agindo
// em nome de quem clicou "Gerar", sem guardar cópia da chave de API de ninguém).
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
  textFields: string[];
  imageFields: string[];
}

function schemaFor(document: TemplateDocument): PageSchema[] {
  return (document.pages ?? []).map((page, i) => ({
    page: i + 1,
    textFields: (page.els ?? [])
      .filter((el): el is TemplateElement & { name: string } => Boolean(el?.type === "text" && el.name))
      .map((el) => el.name),
    imageFields: (page.els ?? [])
      .filter((el): el is TemplateElement & { name: string } => Boolean(el?.type === "image" && el.name))
      .map((el) => el.name),
  }));
}

function buildPrompt(theme: string, schema: PageSchema[]): string {
  const descricao = schema
    .map(({ page, textFields, imageFields }) =>
      `Página ${page}: textos [${textFields.join(", ")}], imagens [${imageFields.join(", ")}]`)
    .join("\n");
  return (
    `Tema: "${theme}"\n\n` +
    `Escreva os textos em português do Brasil, tom direto. Para cada camada de imagem, escreva ` +
    `uma descrição visual concreta, sem texto dentro da imagem, adequada tanto para busca em banco ` +
    `de fotos quanto para geração fotorealista. Devolva somente JSON no formato ` +
    `{"1":{"text":{"titulo":"..."},"images":{"imagem":"descrição..."}}}. ` +
    `Use exatamente os nomes listados.\n\n${descricao}`
  );
}

interface CompletionPage {
  text?: Record<string, string>;
  images?: Record<string, string>;
}

async function callOpenAI(apiKey: string, prompt: string): Promise<Record<string, CompletionPage>> {
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

  let body: {
    templateId?: string;
    theme?: string;
    name?: string;
    idempotencyKey?: string;
    imageStrategy?: "stock" | "ai";
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const { templateId, theme, idempotencyKey } = body;
  const imageStrategy = body.imageStrategy ?? "stock";
  if (!templateId || !theme?.trim() || !idempotencyKey?.trim()) {
    return json({ error: "missing required field: templateId, theme, idempotencyKey" }, 400);
  }
  if (imageStrategy !== "stock" && imageStrategy !== "ai") return json({ error: "imageStrategy must be stock or ai" }, 400);

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
  const totalFields = schema.reduce((n, p) => n + p.textFields.length + p.imageFields.length, 0);
  if (totalFields === 0) return json({ error: "this template has no named text or image fields for the AI to fill in" }, 400);

  let completion: Record<string, CompletionPage>;
  try {
    completion = await callOpenAI(openaiKey, buildPrompt(theme, schema));
  } catch (err) {
    return json({ error: `OpenAI: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  const pages = schema.map(({ page, textFields, imageFields }) => {
    const layers: Record<string, unknown> = {};
    for (const field of textFields) {
      const value = completion[String(page)]?.text?.[field];
      if (typeof value === "string" && value.trim()) {
        layers[field] = { text: value };
      }
    }
    for (const field of imageFields) {
      const description = completion[String(page)]?.images?.[field] || theme;
      layers[field] = {
        asset: {
          strategy: imageStrategy,
          ...(imageStrategy === "stock" ? { query: description } : { prompt: description }),
          aspectRatio: "4:5",
        },
      };
    }
    return { page, layers };
  });

  const generationRes = await fetch(`${fastifyUrl}/api/v1/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader,
      "idempotency-key": idempotencyKey.trim(),
    },
    body: JSON.stringify({
      template: templateId,
      name: body.name?.trim() || theme.trim().slice(0, 80),
      pages,
    }),
  });
  const generation = await generationRes.json().catch(() => ({}));
  if (!generationRes.ok) {
    return json({ error: generation.error ?? generation.message ?? "generation failed" }, generationRes.status);
  }
  return json({ ...generation, generatedFields: completion }, generationRes.status);
});
