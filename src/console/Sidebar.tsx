import { useState } from "react";
import { LayoutGrid, TerminalSquare, Upload, KeyRound, PanelLeft, Search, Monitor, Sun, Moon } from "lucide-react";
import { getTheme, setTheme, type ThemeChoice } from "../theme";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { goToView, set, useConsole, type View } from "./store";

const NAV: ReadonlyArray<{ view: View; label: string; icon: typeof LayoutGrid }> = [
  { view: "templates", label: "Templates", icon: LayoutGrid },
  { view: "playground", label: "Playground", icon: TerminalSquare },
  { view: "import", label: "Importar", icon: Upload },
  { view: "keys", label: "Chaves de API", icon: KeyRound },
];

const THEME_OPTIONS = [
  { value: "system" as const, title: "Sistema", label: <Monitor size={13} /> },
  { value: "light" as const, title: "Claro", label: <Sun size={13} /> },
  { value: "dark" as const, title: "Escuro", label: <Moon size={13} /> },
];

const THEME_ICON: Record<ThemeChoice, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };
const THEME_ORDER: ThemeChoice[] = ["system", "light", "dark"];

/** O tema mora em theme.ts (documentElement + localStorage), fora do store do console, então tem seu próprio useState só para forçar o repaint do controle. */
function ThemeControl({ expanded }: { expanded: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>(getTheme);

  function apply(next: ThemeChoice) {
    setTheme(next);
    setChoice(next);
  }

  if (!expanded) {
    const Icon = THEME_ICON[choice];
    return (
      <button
        type="button"
        title={`Tema: ${choice}`}
        aria-label={`Tema: ${choice}`}
        onClick={() => apply(THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length])}
        className="mx-2 flex h-8 items-center justify-center rounded-sm text-faint hover:bg-surface-2 hover:text-muted"
      >
        <Icon size={13} />
      </button>
    );
  }

  return (
    <Segmented
      aria-label="Tema"
      value={choice}
      onValueChange={apply}
      options={THEME_OPTIONS}
      size="icon"
      className="mx-2 bg-surface-2 p-[3px]"
    />
  );
}

export function Sidebar() {
  const s = useConsole();
  const expanded = !s.collapsed;

  return (
    <aside
      className={cn(
        "flex flex-none flex-col border-r border-line bg-surface py-3.5",
        s.collapsed ? "w-16" : "w-56",
      )}
    >
      <div className={cn("flex items-center gap-2.5 px-3 pb-3.5", s.collapsed && "justify-center")}>
        {expanded && (
          <span className="flex-1 whitespace-nowrap font-display text-xs font-semibold -tracking-[0.01em]">
            Blank Editor
          </span>
        )}
        <button
          type="button"
          title={s.collapsed ? "Expandir menu" : "Recolher menu"}
          aria-label={s.collapsed ? "Expandir menu" : "Recolher menu"}
          aria-expanded={expanded}
          onClick={() => set("collapsed", !s.collapsed)}
          className="flex h-6.5 w-6.5 flex-none items-center justify-center rounded-sm text-muted hover:bg-surface-2"
        >
          <PanelLeft size={15} strokeWidth={1.4} />
        </button>
      </div>

      {expanded && (
        <div className="px-2 pb-3.5">
          <div className="flex h-8 items-center gap-2 rounded-sm border border-line bg-surface-2 px-2.5">
            <Search size={12} strokeWidth={1.5} className="flex-none text-faint" />
            <input
              value={s.search}
              onChange={(e) => set("search", e.target.value)}
              placeholder="Buscar…"
              aria-label="Buscar"
              className="min-w-0 flex-1 border-none bg-transparent text-xs text-text outline-none"
            />
          </div>
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-2 text-[10px] uppercase tracking-[0.1em] text-faint">Plataforma</div>
      )}

      <nav className="flex flex-col gap-0.5 px-2">
        {NAV.map(({ view, label, icon: Icon }) => {
          const active = s.view === view;
          return (
            <button
              key={view}
              type="button"
              onClick={() => goToView(view)}
              aria-current={active ? "page" : undefined}
              title={s.collapsed ? label : undefined}
              className={cn(
                "flex h-8.5 items-center gap-2.5 rounded-sm px-2.5 text-xs font-medium transition-colors",
                s.collapsed ? "justify-center" : "justify-start",
                active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <Icon size={15} strokeWidth={1.4} className="flex-none" />
              {expanded && <span className="whitespace-nowrap">{label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      <ThemeControl expanded={expanded} />
    </aside>
  );
}
