import { AlertTriangle, Loader2, MessageSquare, Search, Send, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import {
  enviarMensagemChat,
  gerarConteudo,
  limparGerar,
  setGerarChatRascunho,
  setGerarModo,
  setGerarTema,
  useConsole,
  type GerarModo,
} from "./store";

const MODOS: ReadonlyArray<{ value: GerarModo; label: string; descricao: string }> = [
  {
    value: "gerar_do_zero",
    label: "Gerar do zero",
    descricao: "A IA escreve só com o tema que você digitou.",
  },
  {
    value: "pesquisar",
    label: "Pesquisar",
    descricao: "Procura o tema na curadoria de perfis do Instagram e usa os posts como referência.",
  },
];

/** O que a tela pede antes de qualquer outra coisa: tema + modo. Fica no topo em vez de num
 *  passo separado porque os dois modos partem exatamente do mesmo input. */
function Composer() {
  const s = useConsole();
  const temaVazio = !s.gerarTema.trim();
  const modoAtual = MODOS.find((m) => m.value === s.gerarModo);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="gerar-tema" className="text-[13px] font-medium">Tema</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="gerar-tema"
            value={s.gerarTema}
            onChange={(e) => setGerarTema(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !temaVazio && !s.gerarCarregando) void gerarConteudo(); }}
            placeholder="Ex.: rotina matinal, skincare, finanças para iniciantes"
            className="flex-1"
          />
          <Button onClick={() => void gerarConteudo()} disabled={temaVazio || s.gerarCarregando}>
            {s.gerarCarregando
              ? <><Loader2 className="size-4 animate-spin" /> Gerando…</>
              : <><Sparkles className="size-4" /> Gerar</>}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Segmented
          value={s.gerarModo}
          onValueChange={setGerarModo}
          options={MODOS.map((m) => ({ value: m.value, label: m.label }))}
          size="tab"
          variant="solid"
          aria-label="Modo de geração"
        />
        {modoAtual ? <p className="text-xs text-faint">{modoAtual.descricao}</p> : null}
      </div>
    </div>
  );
}

/** De onde veio o conteúdo — a especificação pede isso explícito: com curadoria, o usuário
 *  precisa ver quantos posts e de quais perfis; sem curadoria, precisa saber que vai cair na
 *  pesquisa externa. */
function Procedencia() {
  const s = useConsole();

  if (s.gerarPrecisaPesquisaExterna) {
    return (
      <div className="flex items-start gap-2.5 rounded-md border border-line bg-inset p-3">
        <AlertTriangle className="mt-px size-4 shrink-0 text-muted" />
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium">Tema não encontrado na curadoria</span>
          <span className="text-xs text-faint">Pesquisa externa será usada para buscar referências deste tema.</span>
        </div>
      </div>
    );
  }

  if (!s.gerarUsouCuradoria || s.gerarReferencias.length === 0) return null;

  const perfis = [...new Set(s.gerarReferencias.map((r) => r.perfil))];
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line bg-inset p-3">
      <div className="flex items-center gap-2">
        <Users className="size-4 shrink-0 text-muted" />
        <span className="text-[13px] font-medium">
          Baseado em {s.gerarReferencias.length} {s.gerarReferencias.length === 1 ? "post" : "posts"} de perfis
          curados no tema “{s.gerarTema.trim()}”
        </span>
      </div>
      <ul className="flex list-none flex-col gap-1.5">
        {s.gerarReferencias.map((r) => (
          <li key={r.post_id} className="text-xs text-muted">
            <span className="font-medium text-text">{r.perfil}</span>
            {r.tema_detectado ? <span className="text-faint"> · {r.tema_detectado}</span> : null}
            {r.resumo ? <div className="text-faint">{r.resumo}</div> : null}
          </li>
        ))}
      </ul>
      <span className="text-xs text-faint">Perfis: {perfis.join(", ")}</span>
    </div>
  );
}

function Campo({ rotulo, valor }: { rotulo: string; valor: string }) {
  if (!valor) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-faint">{rotulo}</span>
      <p className="whitespace-pre-wrap text-[13px]">{valor}</p>
    </div>
  );
}

function Resultado() {
  const s = useConsole();
  const c = s.gerarConteudo;
  if (!c) return null;

  return (
    <div className="flex flex-col gap-4 rounded-md border border-line bg-surface p-4">
      <Campo rotulo="Título" valor={c.titulo} />
      <Campo rotulo="Gancho" valor={c.gancho} />
      <Campo rotulo="Legenda" valor={c.legenda} />
      {c.roteiro && c.roteiro.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Roteiro</span>
          <ol className="flex list-decimal flex-col gap-1 pl-4 text-[13px]">
            {c.roteiro.map((slide, i) => <li key={i}>{slide}</li>)}
          </ol>
        </div>
      ) : null}
      <Campo rotulo="CTA" valor={c.cta} />
      {c.hashtags.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Hashtags</span>
          <div className="flex flex-wrap gap-1.5">
            {c.hashtags.map((h) => (
              <span key={h} className="rounded-sm bg-inset px-2 py-0.5 text-xs text-muted">
                {h.startsWith("#") ? h : `#${h}`}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={limparGerar}>Descartar rascunho</Button>
      </div>
    </div>
  );
}

/** Chat de refinamento. Só aparece depois que existe rascunho — a especificação é explícita em
 *  não misturar isto com o modo Pesquisar (aqui nunca se consulta a curadoria de novo). */
function Chat() {
  const s = useConsole();
  if (!s.gerarConteudo) return null;

  const vazio = !s.gerarChatRascunho.trim();

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="size-4 text-muted" />
        <span className="text-[13px] font-medium">Chat</span>
        <span className="text-xs text-faint">refine o texto acima — não refaz a pesquisa</span>
      </div>

      {s.gerarChat.length > 0 ? (
        <ul className="flex list-none flex-col gap-2">
          {s.gerarChat.map((m, i) => (
            <li
              key={i}
              className={m.autor === "voce"
                ? "self-end rounded-md bg-accent-soft px-3 py-1.5 text-[13px] text-accent"
                : "self-start rounded-md bg-inset px-3 py-1.5 text-[13px]"}
            >
              {m.texto}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2">
        <Input
          value={s.gerarChatRascunho}
          onChange={(e) => setGerarChatRascunho(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !vazio && !s.gerarChatEnviando) void enviarMensagemChat(); }}
          placeholder="Ex.: deixe mais curto, mais autoridade, adicione CTA"
          className="flex-1"
        />
        <Button onClick={() => void enviarMensagemChat()} disabled={vazio || s.gerarChatEnviando} size="icon" aria-label="Enviar">
          {s.gerarChatEnviando ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

function EstadoVazio() {
  const s = useConsole();
  if (s.gerarConteudo || s.gerarCarregando || s.gerarErro) return null;
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line p-8 text-center">
      <Search className="size-5 text-faint" />
      <span className="text-[13px] font-medium">Nenhum conteúdo gerado ainda</span>
      <span className="max-w-sm text-xs text-faint">
        Digite um tema e escolha entre gerar do zero ou pesquisar na curadoria de perfis do Instagram.
      </span>
    </div>
  );
}

export function GerarView() {
  const s = useConsole();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Gerar</h1>
        <p className="text-[13px] text-muted">
          Conteúdo por tema — do zero ou baseado nos perfis que a curadoria acompanha.
        </p>
      </div>

      <Composer />

      {s.gerarErro ? (
        <div className="flex items-start gap-2.5 rounded-md border border-danger/40 bg-danger/5 p-3">
          <AlertTriangle className="mt-px size-4 shrink-0 text-danger" />
          <span className="text-[13px] text-danger">{s.gerarErro}</span>
        </div>
      ) : null}

      {s.gerarCarregando ? (
        <div className="flex items-center justify-center gap-2 rounded-md border border-line p-8 text-[13px] text-muted">
          <Loader2 className="size-4 animate-spin" />
          {s.gerarModo === "pesquisar" ? "Pesquisando na curadoria e gerando…" : "Gerando conteúdo…"}
        </div>
      ) : null}

      <Procedencia />
      <Resultado />
      <Chat />
      <EstadoVazio />
    </div>
  );
}
