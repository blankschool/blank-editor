import { useState } from "react";
import { FileText } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  askDeleteTemplate,
  copyText,
  duplicateTemplate,
  goToView,
  openNamePrompt,
  openTemplateById,
  selectTemplate,
  useConsole,
  type TemplateSummary,
} from "./store";

/**
 * A capa vem de GET /api/v1/templates/:id/cover. Antes um MutationObserver em
 * main.ts injetava esse <img> em toda `.tplcard` que aparecesse, porque o card
 * nascia de innerHTML e não havia onde pendurar o onError. Agora o card é dono
 * da própria capa, e a falha de carga é só um estado local — o observer, as
 * regras de `[data-broken]` em chrome.css e o querySelectorAll saíram.
 */
function Cover({ id }: { id: string }) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return <FileText size={28} strokeWidth={1.5} aria-hidden />;
  }
  return (
    <img
      src={`/api/v1/templates/${encodeURIComponent(id)}/cover`}
      alt=""
      onError={() => setBroken(true)}
      className="block h-full w-full object-cover"
    />
  );
}

export function TemplateCard({ template }: { template: TemplateSummary }) {
  const s = useConsole();
  const { id, name } = template;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => openTemplateById(id)}
          className="group flex flex-col overflow-hidden rounded-lg border border-line bg-surface text-left transition-[border-color,box-shadow,transform] duration-100 hover:-translate-y-px hover:border-line-strong hover:shadow-pop"
        >
          <div className="flex aspect-video items-center justify-center overflow-hidden bg-surface-2 text-faint group-hover:text-muted">
            <Cover id={id} />
          </div>
          <div className="flex flex-col gap-0.5 px-3.5 py-3">
            <strong className="font-display text-[13.5px] font-semibold text-text">{name}</strong>
            <span className="text-[11px] text-faint">clique p/ editar · botão direito p/ mais opções</span>
          </div>
        </button>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            selectTemplate(id);
            goToView("playground");
          }}
        >
          Abrir no playground
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openNamePrompt("rename-template", "Renomear template", { id, value: name })}>
          Renomear
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => duplicateTemplate(id, name)}>Duplicar</ContextMenuItem>
        {/* onSelect com preventDefault: o menu tem que ficar aberto para o "ID copiado" ser visto. */}
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault();
            copyText(id, `tpl-${id}`);
          }}
        >
          {s.copied === `tpl-${id}` ? "ID copiado" : "Copiar ID"}
        </ContextMenuItem>
        <ContextMenuItem disabled title="em breve">
          Mover
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => askDeleteTemplate(id, name)}>
          Excluir
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
