import { useEffect } from "react";
import { CloudOff, Plus, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { goToView, loadTemplates, openNewDesign, recentTemplates, set, useConsole } from "./store";
import { DesignCard } from "./DesignCard";

const SORTS = [{ value: "Recentes" }, { value: "A-Z" }, { value: "Favoritos" }] as const;

const newDesign = openNewDesign;

/** O card grande. Primeira coisa da home: abrir num grid sem ação é o que fazia a tela parecer listagem de servidor. */
function NewDesignCard() {
  return (
    <button
      type="button"
      onClick={newDesign}
      className="group flex min-h-[210px] flex-col items-start justify-center gap-4 rounded-lg border border-accent/40 bg-accent-soft p-6 text-left transition-[border-color,transform] duration-100 hover:-translate-y-px hover:border-accent"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-md bg-accent text-on-accent transition-transform duration-100 group-hover:scale-105">
        <Plus size={20} strokeWidth={2.2} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="font-display text-[15px] font-semibold text-text">Novo design</span>
        <span className="text-xs leading-relaxed text-muted">
          Escolha um modelo pronto. As camadas já vêm nomeadas para a API.
        </span>
      </div>
    </button>
  );
}

/** Estado vazio de produto: título, uma frase, um botão. Sem "importe um JSON". */
function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-line bg-surface px-6 py-16 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Sparkles size={20} strokeWidth={1.6} />
      </div>
      <div className="flex max-w-[400px] flex-col gap-2">
        <span className="font-display text-[17px] font-semibold -tracking-[0.01em]">Nenhum design ainda</span>
        <span className="text-[13px] leading-relaxed text-faint">
          Crie o primeiro carrossel em 30 segundos. Depois é só chamar a API com o texto de cada post.
        </span>
      </div>
      <Button size="xl" onClick={newDesign}>
        <Plus size={15} strokeWidth={2} />
        Criar meu primeiro design
      </Button>
      {/* Importar PDF continua existindo, mas como saída secundária e em texto —
          era jargão de programador ocupando o lugar da ação principal. */}
      <button
        type="button"
        onClick={() => goToView("import")}
        className="flex items-center gap-1.5 text-[11px] text-faint hover:text-muted"
      >
        <Upload size={12} strokeWidth={1.5} />
        ou importar um PDF do Canva
      </button>
    </div>
  );
}

/**
 * Lista vazia e lista que não carregou são coisas diferentes, e tratá-las igual
 * é mentir: com a API fora do ar o console convidava a "criar o primeiro
 * design" para quem já tem vinte. Aqui o vazio só é vazio quando a última
 * sincronização deu certo.
 */
function LoadFailedState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-line bg-surface px-6 py-16 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-danger-bg text-danger">
        <CloudOff size={20} strokeWidth={1.6} />
      </div>
      <div className="flex max-w-[400px] flex-col gap-2">
        <span className="font-display text-[17px] font-semibold -tracking-[0.01em]">Não deu para carregar</span>
        <span className="text-[13px] leading-relaxed text-faint">
          Seus designs continuam no servidor — só não conseguimos falar com ele agora.
        </span>
      </div>
      <Button variant="outline" size="xl" onClick={() => loadTemplates()}>
        Tentar de novo
      </Button>
    </div>
  );
}

export function DesignsView() {
  const s = useConsole();

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible" && location.hash.startsWith("#/console/designs")) {
        void loadTemplates();
      }
    };
    const interval = window.setInterval(refreshIfVisible, 15_000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, []);

  const query = s.search.trim().toLowerCase();
  const searching = query.length > 0;

  const byName = [...s.templates].sort((a, b) => a.name.localeCompare(b.name));
  const favorites = s.templates.filter((t) => t.favorite);
  const all = s.sort === "A-Z" ? byName : s.sort === "Favoritos" ? favorites : s.templates;
  const visible = searching ? all.filter((t) => t.name.toLowerCase().includes(query)) : all;

  const recent = recentTemplates(3);
  // A seção de baixo é O RESTO, não "todos": com os recentes repetidos embaixo, os
  // três primeiros designs apareciam duas vezes na mesma tela e a home parecia
  // quebrada. Assim a lista não tem duplicata e também não perde ninguém.
  const recentIds = new Set(recent.map((t) => t.id));
  const rest = all.filter((t) => !recentIds.has(t.id));

  // Em A-Z e Favoritos a faixa de recentes sai: os dois já são uma lista filtrada/
  // ordenada de propósito, e três itens arbitrários no topo brigariam com isso.
  // "Recentes" é a home com destaque; os outros dois são navegar um subconjunto específico.
  const heroLayout = !searching && s.sort === "Recentes";

  if (!s.templatesLoaded) {
    return <div className="p-5 font-mono text-xs text-faint">carregando…</div>;
  }

  return (
    <div className="flex flex-col gap-7 p-5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-[17px] font-semibold -tracking-[0.01em]">Seus designs</h1>
          <span className="text-xs text-faint">
            {searching
              ? `${visible.length} de ${all.length}`
              : all.length === 0
                ? s.sync === "failed"
                  ? "lista indisponível"
                  : "nada por aqui ainda"
                : `${all.length} ${all.length === 1 ? "design" : "designs"}`}
          </span>
        </div>
        <div className="flex-1" />
        {/* Total de designs, não `all.length`: "Favoritos" filtra a lista, e se isso
            escondesse o controle junto, filtrar pra zero favoritos trancaria a pessoa
            nessa visão sem jeito de voltar pra "Recentes". */}
        {s.templates.length > 1 && (
          <Segmented aria-label="Ordenar" value={s.sort} onValueChange={(v) => set("sort", v)} options={SORTS} />
        )}
      </div>

      {all.length === 0 ? (
        s.sync === "failed" ? (
          <LoadFailedState />
        ) : s.sort === "Favoritos" && s.templates.length > 0 ? (
          <div className="py-12 text-center text-[13px] text-faint">Nenhum design favoritado ainda.</div>
        ) : (
          <EmptyState />
        )
      ) : searching ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.length ? (
            visible.map((t) => <DesignCard key={t.id} template={t} />)
          ) : (
            <div className="col-span-full py-12 text-center text-[13px] text-faint">
              Nenhum design com “{s.search.trim()}”.
            </div>
          )}
        </div>
      ) : heroLayout ? (
        <>
          {/* Card grande + os últimos editados. O 1.4fr dá o "grande" sem tirar os
              três recentes da mesma linha. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <NewDesignCard />
            {recent.map((t) => (
              <DesignCard key={t.id} template={t} />
            ))}
          </div>

          {rest.length > 0 && (
            <div className="flex flex-col gap-4">
              <h2 className="text-[11px] uppercase tracking-[0.08em] text-faint">Mais antigos</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {rest.map((t) => (
                  <DesignCard key={t.id} template={t} />
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <NewDesignCard />
          {all.map((t) => (
            <DesignCard key={t.id} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}
