import { ChevronLeft, ChevronRight, FileDown, KeyRound, LogOut, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { navigate } from "../router";
import { goToView, useConsole, type View } from "./store";
import { WORKSPACE, workspaceInitials } from "./workspace";

const DEV_ENTRIES: ReadonlyArray<{
  view: View;
  label: string;
  hint: string;
  icon: typeof TerminalSquare;
}> = [
  {
    view: "playground",
    label: "Playground",
    hint: "Testar POST /api/v1/render e copiar o código pronto.",
    icon: TerminalSquare,
  },
  {
    view: "import",
    label: "Importar JSON",
    hint: "Subir um documento que o editor já salvou como design novo.",
    icon: FileDown,
  },
  {
    view: "keys",
    label: "Chaves de API",
    hint: "Criar e revogar as chaves que autorizam o render.",
    icon: KeyRound,
  },
];

/**
 * Cabeçalho das três telas de desenvolvedor. Elas saíram do menu principal, então
 * precisam dizer de onde vieram e como voltar — sem isso, playground e chaves
 * ficariam acessíveis só por URL, sem contexto na tela.
 */
export function DevViewHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => goToView("account")}
        className="flex items-center gap-1 rounded-sm py-1 pl-1 pr-2 text-xs text-faint hover:bg-surface-2 hover:text-text"
      >
        <ChevronLeft size={14} strokeWidth={1.6} />
        Conta
      </button>
      <span aria-hidden className="text-faint">
        /
      </span>
      <h1 className="font-display text-[15px] font-semibold -tracking-[0.01em]">{title}</h1>
      <div className="flex-1" />
      {children}
    </div>
  );
}

export function AccountView() {
  const s = useConsole();
  const liveKeys = s.keys.filter((k) => !k.revoked).length;

  return (
    <div className="flex max-w-[720px] flex-col gap-6 p-5">
      <h1 className="font-display text-[17px] font-semibold -tracking-[0.01em]">Conta</h1>

      <div className="flex items-center gap-4 rounded-lg border border-line bg-surface p-4.5">
        <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line-strong bg-surface-2 text-[13px] font-semibold text-muted">
          {workspaceInitials()}
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <span className="font-display text-sm font-semibold">{WORKSPACE.name}</span>
          <span className="text-xs text-faint">
            {WORKSPACE.brand} · plano atual
          </span>
        </div>
        <span className="flex-none rounded-full bg-accent-soft px-3 py-1.5 text-[11px] font-medium text-accent">
          {WORKSPACE.plan}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[11px] uppercase tracking-[0.08em] text-faint">Desenvolvedor</h2>
          <span className="text-xs leading-relaxed text-faint">
            O que os designs viram do lado da API. Você não precisa disso para desenhar.
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {DEV_ENTRIES.map(({ view, label, hint, icon: Icon }, index) => (
            <button
              key={view}
              type="button"
              onClick={() => goToView(view)}
              className={`flex w-full items-center gap-3.5 px-4 py-3.5 text-left hover:bg-surface-2 ${
                index > 0 ? "border-t border-line" : ""
              }`}
            >
              <Icon size={16} strokeWidth={1.5} className="flex-none text-muted" />
              <div className="flex flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-medium">{label}</span>
                <span className="text-xs text-faint">{hint}</span>
              </div>
              {view === "keys" && s.keysLoaded && (
                <span className="flex-none font-mono text-[11px] text-faint">
                  {liveKeys} {liveKeys === 1 ? "ativa" : "ativas"}
                </span>
              )}
              <ChevronRight size={15} strokeWidth={1.4} className="flex-none text-faint" />
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-line px-4 py-3.5">
        <span className="flex-1 text-xs text-faint">
          Sair devolve à tela de login. Ela ainda não autentica ninguém — nada aqui é privado.
        </span>
        <Button variant="dangerGhost" size="md" onClick={() => navigate("login")}>
          <LogOut size={14} strokeWidth={1.5} />
          Sair
        </Button>
      </div>
    </div>
  );
}
