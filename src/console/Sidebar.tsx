import { useState } from "react";
import { LayoutGrid, Monitor, Moon, PanelLeft, Plus, Search, Settings, Sun } from "lucide-react";
import { getTheme, setTheme, type ThemeChoice } from "../theme";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { DEV_VIEWS, goToView, openNamePrompt, set, useConsole, type View } from "./store";

/**
 * Três itens, não quatro de peso igual.
 *
 * O menu antigo era Templates / Playground / Importar / Chaves: quatro entradas
 * do mesmo tamanho, sendo três delas ferramentas de integração. Isso descreve a
 * API, não o produto. Agora é Designs (a única coisa que se faz aqui todo dia),
 * Novo (ação, não destino — por isso é botão e não link) e Conta, que abriga o
 * bloco Desenvolvedor com playground, importação e chaves.
 */
const NAV: ReadonlyArray<{ view: View; label: string; icon: typeof LayoutGrid }> = [
  { view: "designs", label: "Designs", icon: LayoutGrid },
  { view: "account", label: "Conta", icon: Settings },
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
      <div className={cn("flex items-center px-3 pb-3", s.collapsed ? "justify-center" : "justify-end")}>
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

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => openNamePrompt("new-template", "Nome do novo design")}
          title={s.collapsed ? "Novo design" : undefined}
          className={cn(
            "flex h-9 w-full items-center gap-2.5 rounded-sm bg-accent px-2.5 text-xs font-medium text-on-accent hover:opacity-90",
            s.collapsed && "justify-center px-0",
          )}
        >
          <Plus size={15} strokeWidth={2} className="flex-none" />
          {expanded && <span className="whitespace-nowrap">Novo design</span>}
        </button>
      </div>

      {expanded && (
        <div className="px-2 pb-3.5 pt-1.5">
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

      <nav className="flex flex-col gap-0.5 px-2">
        {NAV.map(({ view, label, icon: Icon }) => {
          // Conta fica marcada enquanto qualquer tela de desenvolvedor está aberta:
          // playground, importação e chaves vivem debaixo dela agora.
          const active = s.view === view || (view === "account" && DEV_VIEWS.includes(s.view));
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
