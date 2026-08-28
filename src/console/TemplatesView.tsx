import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { goToView, openNamePrompt, set, useConsole } from "./store";
import { TemplateCard } from "./TemplateCard";

const SORTS = [{ value: "Ordem" }, { value: "A-Z" }] as const;
const PERIODS = [{ value: "Todos" }, { value: "Hoje" }, { value: "7D" }, { value: "14D" }, { value: "30D" }] as const;

export function TemplatesView() {
  const s = useConsole();
  const query = s.search.trim().toLowerCase();
  const visible = query ? s.templates.filter((t) => t.name.toLowerCase().includes(query)) : s.templates;

  const emptyMessage = !s.templatesLoaded
    ? "carregando…"
    : s.templates.length === 0
      ? "nenhum template ainda — crie um ou importe um JSON"
      : "nenhum template bate com a busca";

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-4.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-faint">Ordenar:</span>
          <Segmented aria-label="Ordenar" value={s.sort} onValueChange={(v) => set("sort", v)} options={SORTS} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-faint">Período:</span>
          <Segmented aria-label="Período" value={s.period} onValueChange={(v) => set("period", v)} options={PERIODS} />
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="md" onClick={() => goToView("import")}>
          <Upload size={13} strokeWidth={1.5} />
          Importar
        </Button>
        <Button size="md" onClick={() => openNamePrompt("new-template", "Nome do novo template")}>
          <Plus size={13} strokeWidth={1.8} />
          Novo template
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {visible.length ? (
          visible.map((t) => <TemplateCard key={t.id} template={t} />)
        ) : (
          <div className="col-span-full p-10 text-center font-mono text-xs text-faint">{emptyMessage}</div>
        )}
      </div>
    </div>
  );
}
