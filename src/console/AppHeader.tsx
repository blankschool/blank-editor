import { LogOut, Settings, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { navigate } from "../router";
import { clearSession, initials, useSession } from "../session";
import { goToView } from "./store";
import { WORKSPACE } from "./workspace";

function BrandMark() {
  return (
    <div
      aria-hidden
      className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent font-display text-base font-bold leading-none text-on-accent"
    >
      B
    </div>
  );
}

export function AppHeader() {
  // O router só mostra esta view com sessão presente, mas a leitura fica
  // defensiva mesmo assim: alguém pode limpar o localStorage manualmente numa
  // aba já aberta, e a UI não deve quebrar por isso — só não sabe mais o nome.
  const session = useSession();
  const name = session?.name ?? "…";

  return (
    <header className="flex h-16 flex-none items-center gap-3 border-b border-line bg-surface/80 px-4 backdrop-blur-md lg:px-8">
      <BrandMark />
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-display text-lg font-bold tracking-tight">
          {WORKSPACE.brand} <span className="font-normal text-faint">·</span> {name}
        </span>
        <span className="hidden truncate text-sm text-muted lg:inline">{WORKSPACE.tagline}</span>
      </div>

      <div className="flex-1" />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Conta"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-line-strong bg-surface-2 text-sm font-semibold text-muted hover:border-accent hover:text-text"
        >
          {session ? initials(session.name) || <UserRound size={18} /> : <UserRound size={18} />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{name}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => goToView("account")}>
            <Settings size={16} strokeWidth={1.5} />
            Conta
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            danger
            onSelect={() => {
              clearSession();
              navigate("login");
            }}
          >
            <LogOut size={16} strokeWidth={1.5} />
            Sair
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
