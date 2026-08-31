import { useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  ExternalLink,
  FileImage,
  KeyRound,
  Layers3,
  Play,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { goToView } from "./store";

const SECTIONS = [
  { id: "inicio", label: "Comece aqui" },
  { id: "agentes", label: "Usar com agentes" },
  { id: "n8n", label: "Configurar no n8n" },
  { id: "referencia", label: "Referência da API" },
] as const;

function CodeBlock({ title, code, language = "javascript" }: { title: string; code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-inset">
      <div className="flex h-10 items-center gap-2 border-b border-line px-3.5">
        <Code2 size={14} className="text-faint" />
        <span className="flex-1 font-mono text-[11px] text-muted">{title}</span>
        <span className="text-[10px] uppercase tracking-[0.08em] text-faint">{language}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="ml-1 flex h-7 items-center gap-1.5 rounded-sm px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-text"
        >
          {copied ? <Check size={13} className="text-success" /> : <Clipboard size={13} />}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <pre className="max-h-[440px] overflow-auto whitespace-pre p-4 font-mono text-[12px] leading-[1.75] text-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="relative flex gap-4 pb-6 last:pb-0">
      <div className="absolute bottom-0 left-[15px] top-8 w-px bg-line last:hidden" aria-hidden />
      <span className="relative z-10 flex h-8 w-8 flex-none items-center justify-center rounded-full border border-line-strong bg-surface font-mono text-[11px] font-semibold text-muted">
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <div className="text-xs leading-6 text-muted">{children}</div>
      </div>
    </div>
  );
}

function Setting({ name, value }: { name: string; value: string }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-3 border-t border-line px-4 py-3 first:border-t-0">
      <span className="text-xs text-faint">{name}</span>
      <code className="break-all font-mono text-[11px] text-text">{value}</code>
    </div>
  );
}

export function DocsView() {
  const baseUrl = location.origin;
  const renderUrl = `${baseUrl}/api/v1/render`;

  const quickStart = `curl -X POST "${renderUrl}" \\
  -H "Authorization: Bearer SUA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "template": "ID_DO_DESIGN",
    "layers": {
      "titulo": { "text": "Seu título aqui" },
      "foto": { "image_url": "https://exemplo.com/foto.jpg" },
      "selo": { "hide": false }
    }
  }' \\
  --output resultado.png`;

  const agentTool = `{
  "name": "render_blank_design",
  "description": "Renderiza um design do Blank como PNG usando um template e suas camadas nomeadas.",
  "parameters": {
    "type": "object",
    "properties": {
      "template": {
        "type": "string",
        "description": "ID do design salvo no Blank"
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "description": "Página do design; começa em 1"
      },
      "layers": {
        "type": "object",
        "description": "Camadas por nome: { text }, { image_url } ou { hide: true }",
        "additionalProperties": {
          "type": "object",
          "properties": {
            "text": { "type": "string" },
            "image_url": { "type": "string", "format": "uri" },
            "hide": { "type": "boolean" }
          }
        }
      }
    },
    "required": ["template", "layers"]
  }
}`;

  const agentHandler = `const BLANK_URL = "${renderUrl}";

export async function renderBlankDesign(args) {
  const response = await fetch(BLANK_URL, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${process.env.BLANK_API_KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template: args.template,
      page: args.page,
      layers: args.layers,
    }),
  });

  if (!response.ok) {
    throw new Error(\`Blank API \${response.status}: \${await response.text()}\`);
  }

  const png = Buffer.from(await response.arrayBuffer());
  return {
    mimeType: "image/png",
    base64: png.toString("base64"),
  };
}`;

  const n8nBody = `{
  "template": "ID_DO_DESIGN",
  "page": 1,
  "layers": {
    "titulo": {
      "text": "={{ $json.titulo }}"
    },
    "foto": {
      "image_url": "={{ $json.imagem }}"
    }
  }
}`;

  const listTemplates = `curl "${baseUrl}/api/v1/templates" \\
  -H "Authorization: Bearer SUA_API_KEY"`;

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col px-5 py-6 lg:px-8 lg:py-8">
      <section className="relative overflow-hidden rounded-xl border border-line bg-surface px-6 py-7 lg:px-8 lg:py-9">
        <div className="absolute -right-14 -top-20 h-64 w-64 rounded-full bg-accent-soft opacity-70 blur-3xl" aria-hidden />
        <div className="relative flex max-w-[760px] flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">
              API v1
            </span>
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Pronta para produção
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-[-0.025em] lg:text-[30px]">
              Transforme seus designs em ferramentas para agentes e automações
            </h1>
            <p className="max-w-[690px] text-sm leading-6 text-muted">
              Crie o layout uma vez no canvas. Depois, um agente ou workflow do n8n troca textos e imagens pelas camadas nomeadas e recebe o PNG pronto.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={() => goToView("playground")}>
              <Play size={14} fill="currentColor" />
              Testar no Playground
            </Button>
            <Button variant="outline" onClick={() => goToView("keys")}>
              <KeyRound size={14} />
              Criar chave de API
            </Button>
          </div>
        </div>
      </section>

      <div className="mt-8 grid gap-8 xl:grid-cols-[190px_minmax(0,1fr)]">
        <aside className="hidden xl:block">
          <div className="sticky top-6 flex flex-col gap-1">
            <span className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">Nesta página</span>
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => scrollTo(section.id)}
                className="flex h-8 items-center rounded-sm px-2 text-left text-xs text-muted hover:bg-surface-2 hover:text-text"
              >
                {section.label}
              </button>
            ))}
            <div className="my-2 h-px bg-line" />
            <a
              href="https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-faint hover:bg-surface-2 hover:text-text"
            >
              Docs do n8n
              <ExternalLink size={11} />
            </a>
          </div>
        </aside>

        <article className="flex min-w-0 flex-col gap-12 pb-16">
          <section id="inicio" className="scroll-mt-6 flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">Comece aqui</span>
              <h2 className="font-display text-xl font-semibold tracking-[-0.02em]">Sua primeira imagem pela API</h2>
              <p className="text-sm leading-6 text-muted">
                Você precisa de um design salvo, nomes nas camadas que serão variáveis e uma chave de API.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {[
                { icon: Layers3, title: "1. Prepare o design", text: "Nomeie as camadas editáveis no painel Camadas, como titulo, foto e selo." },
                { icon: KeyRound, title: "2. Crie uma chave", text: "Em Chaves de API, crie uma chave exclusiva para o agente ou para o n8n." },
                { icon: FileImage, title: "3. Renderize", text: "Envie os valores por POST. A resposta é o arquivo PNG, não um JSON." },
              ].map(({ icon: Icon, title, text }) => (
                <div key={title} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-soft text-accent">
                    <Icon size={17} />
                  </span>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[13px] font-semibold">{title}</h3>
                    <p className="text-xs leading-5 text-muted">{text}</p>
                  </div>
                </div>
              ))}
            </div>

            <CodeBlock title="Primeiro render" language="cURL" code={quickStart} />

            <div className="flex items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3.5">
              <ShieldCheck size={17} className="mt-0.5 flex-none text-success" />
              <p className="text-xs leading-5 text-muted">
                Guarde a chave no servidor ou no cofre de credenciais do n8n. Não coloque <code className="font-mono text-[11px] text-text">blk_…</code> em prompts, no frontend ou em repositórios.
              </p>
            </div>
          </section>

          <section id="agentes" className="scroll-mt-6 flex flex-col gap-5 border-t border-line pt-10">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Bot size={19} />
              </span>
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">Agentes</span>
                <h2 className="font-display text-xl font-semibold tracking-[-0.02em]">Exponha o render como uma ferramenta</h2>
                <p className="text-sm leading-6 text-muted">
                  O agente decide o conteúdo e chama uma função com dados estruturados. Seu código executa a chamada HTTP e devolve o PNG ou salva o arquivo.
                </p>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <CodeBlock title="Contrato da ferramenta" language="JSON Schema" code={agentTool} />
              <CodeBlock title="Executor da ferramenta" language="Node.js" code={agentHandler} />
            </div>

            <div className="rounded-lg border border-line bg-surface p-4">
              <h3 className="mb-3 text-[13px] font-semibold">Instrução recomendada para o agente</h3>
              <blockquote className="border-l-2 border-accent pl-4 text-xs leading-6 text-muted">
                Quando o usuário pedir uma arte, use <code className="font-mono text-[11px] text-text">render_blank_design</code>. Preserve o ID do template configurado, preencha somente camadas existentes e nunca invente nomes de camada. Use URLs públicas em imagens. Peça confirmação antes de renderizar se faltar conteúdo obrigatório.
              </blockquote>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {[
                ["O agente cria o conteúdo", "Título, legenda, CTA e escolha de imagem."],
                ["A ferramenta limita a ação", "Template e campos ficam validados pelo schema."],
                ["O Blank mantém o layout", "Fonte, posição, tamanho e identidade ficam no design."],
              ].map(([title, text]) => (
                <div key={title} className="rounded-lg border border-line bg-surface p-4">
                  <h3 className="text-[13px] font-semibold">{title}</h3>
                  <p className="mt-1 text-xs leading-5 text-muted">{text}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="n8n" className="scroll-mt-6 flex flex-col gap-5 border-t border-line pt-10">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Workflow size={19} />
              </span>
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">n8n</span>
                <h2 className="font-display text-xl font-semibold tracking-[-0.02em]">Monte o workflow em quatro passos</h2>
                <p className="text-sm leading-6 text-muted">
                  O nó HTTP Request chama a API e guarda a resposta como arquivo binário para o próximo nó enviar, publicar ou armazenar.
                </p>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(330px,.85fr)]">
              <div className="rounded-lg border border-line bg-surface p-5">
                <Step number={1} title="Adicione o gatilho">
                  Use Manual Trigger para testar. Depois troque por Webhook, Schedule, formulário ou o gatilho que inicia sua automação.
                </Step>
                <Step number={2} title="Prepare os campos">
                  Use Edit Fields para produzir valores como <code className="font-mono text-[11px] text-text">titulo</code> e <code className="font-mono text-[11px] text-text">imagem</code>. Um AI Agent também pode preencher esses valores antes do render.
                </Step>
                <Step number={3} title="Configure HTTP Request">
                  Use os valores do quadro ao lado. A API devolve bytes de imagem, por isso Response Format precisa ser File.
                </Step>
                <Step number={4} title="Use o arquivo">
                  O PNG estará na propriedade binária <code className="font-mono text-[11px] text-text">data</code>. Conecte Google Drive, S3, Telegram, WhatsApp ou outro destino.
                </Step>
              </div>

              <div className="overflow-hidden rounded-lg border border-line bg-surface self-start">
                <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <Workflow size={15} className="text-accent" />
                  <h3 className="text-[13px] font-semibold">HTTP Request</h3>
                </div>
                <Setting name="Method" value="POST" />
                <Setting name="URL" value={renderUrl} />
                <Setting name="Authentication" value="Generic Credential Type → Header Auth" />
                <Setting name="Header name" value="Authorization" />
                <Setting name="Header value" value="Bearer SUA_API_KEY" />
                <Setting name="Body Content Type" value="JSON" />
                <Setting name="Response Format" value="File" />
                <Setting name="Output Property" value="data" />
              </div>
            </div>

            <CodeBlock title="Body JSON do HTTP Request" language="n8n expression" code={n8nBody} />

            <div className="rounded-lg border border-line bg-surface p-4">
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-accent" />
                <h3 className="text-[13px] font-semibold">Se estiver usando AI Agent no n8n</h3>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted">
                Coloque o render em um subworkflow com os inputs <code className="font-mono text-[11px] text-text">titulo</code>, <code className="font-mono text-[11px] text-text">imagem</code> e outros campos do design. Ligue esse subworkflow ao agente com Call n8n Workflow Tool. Assim a credencial e o ID do template ficam fora do prompt.
              </p>
            </div>
          </section>

          <section id="referencia" className="scroll-mt-6 flex flex-col gap-5 border-t border-line pt-10">
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">Referência</span>
              <h2 className="font-display text-xl font-semibold tracking-[-0.02em]">Endpoint de render</h2>
              <p className="text-sm leading-6 text-muted">
                Todas as chamadas usam <code className="font-mono text-[12px] text-text">Authorization: Bearer SUA_API_KEY</code>.
              </p>
            </div>

            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
                <span className="rounded-sm bg-accent-soft px-2 py-1 font-mono text-[10px] font-bold text-accent">POST</span>
                <code className="font-mono text-xs text-text">/api/v1/render</code>
                <span className="ml-auto text-xs text-faint">Retorna image/png</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="bg-surface-2 text-faint">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Campo</th>
                      <th className="px-4 py-2.5 font-medium">Tipo</th>
                      <th className="px-4 py-2.5 font-medium">Uso</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {[
                      ["template", "string", "Obrigatório. ID do design salvo."],
                      ["page", "integer", "Opcional. Página base 1 para carrosséis."],
                      ["layers", "object", "Camadas nomeadas que serão substituídas ou ocultadas."],
                      ["save", "boolean", "Opcional. Sobrescreve o template; padrão false."],
                    ].map(([field, type, description]) => (
                      <tr key={field}>
                        <td className="px-4 py-3 font-mono text-[11px] text-text">{field}</td>
                        <td className="px-4 py-3 font-mono text-[11px] text-faint">{type}</td>
                        <td className="px-4 py-3 leading-5 text-muted">{description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {[
                ["text", '{ "text": "Novo texto" }', "Troca o conteúdo de uma camada de texto."],
                ["image_url", '{ "image_url": "https://…" }', "Troca a imagem usando uma URL acessível pela API."],
                ["hide", '{ "hide": true }', "Oculta a camada somente neste render."],
              ].map(([name, example, text]) => (
                <div key={name} className="rounded-lg border border-line bg-surface p-4">
                  <code className="font-mono text-[11px] font-semibold text-accent">{name}</code>
                  <pre className="my-2 overflow-auto rounded-sm bg-inset p-2.5 font-mono text-[10px] text-text">{example}</pre>
                  <p className="text-xs leading-5 text-muted">{text}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-[13px] font-semibold">Encontrar IDs de designs</h3>
                  <p className="mt-1 text-xs text-muted">Liste apenas os designs pertencentes à chave usada.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => goToView("playground")}>
                  Playground
                  <ArrowRight size={13} />
                </Button>
              </div>
              <CodeBlock title="Listar designs" language="cURL" code={listTemplates} />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["400", "Requisição inválida", "Campo obrigatório ausente, página fora do intervalo ou layer incompatível."],
                ["401", "Não autorizado", "Chave ausente, revogada ou inválida."],
                ["404", "Design não encontrado", "O ID não existe ou pertence a outra conta."],
              ].map(([status, title, text]) => (
                <div key={status} className="rounded-lg border border-line bg-surface p-4">
                  <div className="flex items-center gap-2">
                    <span className={cn("font-mono text-[11px] font-bold", status === "401" ? "text-danger" : "text-warning")}>{status}</span>
                    <ChevronRight size={12} className="text-faint" />
                    <span className="text-xs font-medium">{title}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted">{text}</p>
                </div>
              ))}
            </div>
          </section>
        </article>
      </div>
    </div>
  );
}
