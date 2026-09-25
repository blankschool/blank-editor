import { useState } from "react";
import { BookOpen, LayoutGrid, Monitor, Moon, PanelLeft, Plus, CircleUserRound, Sun } from "lucide-react";
import { getTheme, setTheme, type ThemeChoice } from "../theme";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { DEV_VIEWS, goToView, openNewDesign, set, useConsole, type View } from "./store";

const NAV: ReadonlyArray<{ view: View; label: string; icon: typeof LayoutGrid }> = [
  { view: "designs", label: "Designs", icon: LayoutGrid },
  { view: "docs", label: "Documentação", icon: BookOpen },
  { view: "account", label: "Conta", icon: CircleUserRound },
];

const THEME_OPTIONS = [
  { value: "system" as const, title: "Sistema", label: <Monitor size={16} /> },
  { value: "light" as const, title: "Claro", label: <Sun size={16} /> },
  { value: "dark" as const, title: "Escuro", label: <Moon size={16} /> },
];

const THEME_ICON: Record<ThemeChoice, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };
const THEME_LABEL: Record<ThemeChoice, string> = { system: "Sistema", light: "Claro", dark: "Escuro" };
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
        title={`Tema: ${THEME_LABEL[choice]}`}
        aria-label={`Tema: ${THEME_LABEL[choice]}`}
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
          onClick={openNewDesign}
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

      <nav className="flex flex-col gap-1 px-3">
        {NAV.map(({ view, label, icon: Icon }) => {
          const active = s.view === view || (view === "account" && DEV_VIEWS.includes(s.view)) || (view === "designs" && s.view === "import");
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
