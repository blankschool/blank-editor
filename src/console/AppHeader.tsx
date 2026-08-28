import { Check, CloudOff, LogOut, RefreshCw, Settings, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { navigate } from "../router";
import { goToView, loadTemplates, useConsole } from "./store";
import { WORKSPACE, workspaceInitials } from "./workspace";

/** Marca. Um "B" numa caixa — sem asset externo, e legível em 24px, que é o tamanho real aqui. */
function BrandMark() {
  return (
    <div
      aria-hidden
      className="flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-accent font-display text-[13px] font-bold leading-none text-on-accent"
    >
      B
    </div>
  );
}

const SYNC_LABEL = {
  ok: "Tudo no ar",
  syncing: "Sincronizando…",
  failed: "Falhou ao sincronizar",
} as const;

/**
 * Estado da sincronização. Clicável quando falhou, porque um aviso de erro sem
 * ação é só uma má notícia — o clique refaz o fetch da lista.
 */
function SyncStatus() {
  const s = useConsole();
  const Icon = s.sync === "failed" ? CloudOff : s.sync === "syncing" ? RefreshCw : Check;

  const content = (
    <>
      <Icon size={12} strokeWidth={1.8} className={cn("flex-none", s.sync === "syncing" && "animate-spin")} />
      <span>{SYNC_LABEL[s.sync]}</span>
    </>
  );

  if (s.sync !== "failed") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-faint" aria-live="polite">
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => loadTemplates()}
      title="Tentar sincronizar de novo"
      className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] text-danger hover:bg-danger-bg"
      aria-live="polite"
    >
      {content}
    </button>
  );
}

export function AppHeader() {
  return (
    <header className="flex h-13 flex-none items-center gap-3 border-b border-line bg-surface px-4">
      <BrandMark />
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-display text-[13px] font-semibold -tracking-[0.01em]">
          {WORKSPACE.brand} <span className="font-normal text-faint">·</span> {WORKSPACE.name}
        </span>
        {/* A tagline some abaixo de 900px: numa tela estreita ela empurra o status de
            sincronização, que é informação de estado e ganha da frase de marketing. */}
        <span className="hidden truncate text-[11px] text-faint lg:inline">{WORKSPACE.tagline}</span>
      </div>

      <div className="flex-1" />
      <SyncStatus />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Conta"
          className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-line-strong bg-surface-2 text-[11px] font-semibold text-muted hover:border-accent hover:text-text"
        >
          {workspaceInitials() || <UserRound size={14} />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{WORKSPACE.name}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => goToView("account")}>
            <Settings size={14} strokeWidth={1.5} />
            Conta
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Sair leva à tela de login de verdade. Ela existe e não autentica nada
              ainda — por isso ela não é a rota de boot —, mas chegar nela por
              escolha é diferente de ser barrado por ela. */}
          <DropdownMenuItem danger onSelect={() => navigate("login")}>
            <LogOut size={14} strokeWidth={1.5} />
            Sair
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
