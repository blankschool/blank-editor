import { useState } from "react";
import { LayoutGrid, Monitor, Moon, PanelLeft, Plus, Search, Settings, Sun } from "lucide-react";
import { getTheme, setTheme, type ThemeChoice } from "../theme";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { DEV_VIEWS, goToView, openNamePrompt, set, useConsole, type View } from "./store";

const NAV: ReadonlyArray<{ view: View; label: string; icon: typeof LayoutGrid }> = [
  { view: "designs", label: "Designs", icon: LayoutGrid },
  { view: "account", label: "Conta", icon: Settings },
];

const THEME_OPTIONS = [
  { value: "system" as const, title: "Sistema", label: <Monitor size={16} /> },
  { value: "light" as const, title: "Claro", label: <Sun size={16} /> },
  { value: "dark" as const, title: "Escuro", label: <Moon size={16} /> },
];

const THEME_ICON: Record<ThemeChoice, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };
const THEME_ORDER: ThemeChoice[] = ["system", "light", "dark"];

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
        className="mx-2 flex h-10 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-muted"
      >
        <Icon size={18} />
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
      className="mx-2 bg-surface-2 p-1"
    />
  );
}

export function Sidebar() {
  const s = useConsole();
  const expanded = !s.collapsed;

  return (
    <aside
      className={cn(
        "flex flex-none flex-col border-r border-line bg-surface py-4",
        s.collapsed ? "w-[72px]" : "w-60",
      )}
    >
      <div className={cn("flex items-center px-3 pb-3", s.collapsed ? "justify-center" : "justify-end")}>
        <button
          type="button"
          title={s.collapsed ? "Expandir menu" : "Recolher menu"}
          aria-label={s.collapsed ? "Expandir menu" : "Recolher menu"}
          aria-expanded={expanded}
          onClick={() => set("collapsed", !s.collapsed)}
          className="flex h-10 w-10 flex-none items-center justify-center rounded-md text-muted hover:bg-surface-2"
        >
          <PanelLeft size={18} strokeWidth={1.6} />
        </button>
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => openNamePrompt("new-template", "Nome do novo design")}
          title={s.collapsed ? "Novo design" : undefined}
          className={cn(
            "flex h-10 w-full items-center gap-2.5 rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:opacity-90",
            s.collapsed && "justify-center px-0",
          )}
        >
          <Plus size={18} strokeWidth={2} className="flex-none" />
          {expanded && <span className="whitespace-nowrap">Novo design</span>}
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-4 pt-1">
          <div className="flex h-10 items-center gap-2 rounded-md border border-line bg-surface-2 px-3">
            <Search size={16} strokeWidth={1.5} className="flex-none text-faint" />
            <input
              value={s.search}
              onChange={(e) => set("search", e.target.value)}
              placeholder="Buscar…"
              aria-label="Buscar"
              className="min-w-0 flex-1 border-none bg-transparent text-sm text-text outline-none"
            />
          </div>
        </div>
      )}

      <nav className="flex flex-col gap-1 px-3">
        {NAV.map(({ view, label, icon: Icon }) => {
          const active = s.view === view || (view === "account" && DEV_VIEWS.includes(s.view));
          return (
            <button
              key={view}
              type="button"
              onClick={() => goToView(view)}
              aria-current={active ? "page" : undefined}
              title={s.collapsed ? label : undefined}
              className={cn(
                "flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
                s.collapsed ? "justify-center" : "justify-start",
                active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <Icon size={18} strokeWidth={1.6} className="flex-none" />
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
