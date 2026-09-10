import { useState } from "react";
import { ImageOff, Pencil, Star } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { relativeTime } from "./relativeTime";
import {
  askDeleteTemplate,
  copyText,
  downloadTemplate,
  duplicateTemplate,
  goToView,
  openTemplateById,
  renameTemplateInline,
  selectTemplate,
  startRenaming,
  toggleTemplateFavorite,
  useConsole,
  type TemplateSummary,
} from "./store";

/**
 * A capa vem de GET /api/v1/templates/:id/cover. Antes um MutationObserver em
 * main.ts injetava esse <img> em toda `.tplcard` que aparecesse, porque o card
 * nascia de innerHTML e não havia onde pendurar o onError. Agora o card é dono
 * da própria capa, e a falha de carga é só um estado local.
 *
 * `version` é o `updatedAt` do design, e existe porque o endpoint responde com
 * `cache-control: private, max-age=20` e a URL era fixa: depois de editar, o
 * navegador reservia a capa antiga e o card só mostrava a nova depois de um
 * refresh. Como chave, o `updatedAt` muda a cada gravação e fica estável entre
 * elas — a capa continua cacheável, mas nunca velha. O mesmo valor vai no `key`
 * do componente, para o estado `broken` de uma capa que falhou não grudar na
 * próxima tentativa.
 */
function Cover({ id, version }: { id: string; version: string }) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <div className="flex flex-col items-center gap-1.5 text-faint">
        <ImageOff size={22} strokeWidth={1.4} aria-hidden />
        <span className="text-[10px]">sem capa</span>
      </div>
    );
  }
  // object-contain, não object-cover: a capa é o artboard inteiro no tamanho real
  // dele (o endpoint devolve 1080x1350 num template de post, 1920x1080 num slide).
  // Recortando para 16:9 o título do design ficava cortado ao meio — e um gerenciador
  // de designs existe justamente para você reconhecer a peça pela miniatura.
  return (
    <img
      src={`/api/v1/templates/${encodeURIComponent(id)}/cover?v=${encodeURIComponent(version)}`}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="max-h-full max-w-full object-contain shadow-[0_1px_4px_rgb(0_0_0/.22)]"
    />
  );
}

/**
 * Nome editável no próprio card. Enter confirma, Escape cancela, blur confirma —
 * blur-confirma porque perder o que se acabou de digitar por clicar fora é pior
 * que salvar um nome que ainda se pode reeditar.
 *
 * A entrada é um botão de lápis que aparece no hover, não duplo clique no texto.
 * Duplo clique parecia o gesto natural e não funciona aqui: `dblclick` é um
 * evento separado dos dois `click` que o precedem, então os cliques subiam para
 * o card e abriam o editor antes de o modo de edição existir. Dava para blindar
 * o texto com stopPropagation no click, mas aí o nome — metade da área útil do
 * rodapé do card — deixaria de abrir o design. Um alvo explícito resolve os dois.
 */
function Name({ template }: { template: TemplateSummary }) {
  const s = useConsole();
  const editing = s.renamingId === template.id;
  const [draft, setDraft] = useState(template.name);

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <strong className="truncate font-display text-[13.5px] font-semibold text-text">{template.name}</strong>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setDraft(template.name);
            startRenaming(template.id);
          }}
          title="Renomear"
          aria-label={`Renomear ${template.name}`}
          className="flex h-5 w-5 flex-none items-center justify-center rounded-[6px] text-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Pencil size={11} strokeWidth={1.7} />
        </button>
      </div>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => renameTemplateInline(template.id, draft)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") renameTemplateInline(template.id, draft);
        if (event.key === "Escape") startRenaming(null);
      }}
      aria-label="Nome do design"
      className="w-full rounded-[6px] border border-accent bg-bg px-1.5 py-0.5 font-display text-[13.5px] font-semibold text-text outline-none"
    />
  );
}

export function DesignCard({ template }: { template: TemplateSummary }) {
  const s = useConsole();
  const { id, name } = template;
  const edited = relativeTime(template.updatedAt);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (s.renamingId !== id) openTemplateById(id);
          }}
          onKeyDown={(event) => {
            if (s.renamingId === id) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openTemplateById(id);
            }
          }}
          className="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-line bg-surface text-left transition-[border-color,box-shadow,transform] duration-100 hover:-translate-y-px hover:border-line-strong hover:shadow-pop focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          {/* Quadrado: os artboards têm proporções diferentes (post 4:5, story 9:16, slide
              16:9) e o quadrado é o que menos desperdiça para todos eles ao mesmo tempo.
              Num tile 4:3 um post ficava com tarja nos dois lados e a miniatura minguava. */}
          <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-inset p-3">
            <Cover key={template.updatedAt} id={id} version={template.updatedAt} />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                toggleTemplateFavorite(id);
              }}
              title={template.favorite ? "Remover dos favoritos" : "Favoritar"}
              aria-label={template.favorite ? `Remover ${name} dos favoritos` : `Favoritar ${name}`}
              aria-pressed={template.favorite}
              className={`absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-surface/90 shadow-pop backdrop-blur transition-opacity ${
                template.favorite ? "opacity-100 text-accent" : "opacity-0 text-faint hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
              }`}
            >
              <Star size={14} strokeWidth={1.8} fill={template.favorite ? "currentColor" : "none"} />
            </button>
          </div>
          <div className="flex flex-col gap-1 px-3.5 py-3">
            <Name template={template} />
            <span className="text-[11px] text-faint">{edited ? `editado ${edited}` : "sem data de edição"}</span>
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            setTimeout(() => startRenaming(id), 0); // depois do restore de foco do Radix, senão o autoFocus do input é desfeito
          }}
        >
          Renomear
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => duplicateTemplate(id, name)}>Duplicar</ContextMenuItem>
        <ContextMenuItem onSelect={() => toggleTemplateFavorite(id)}>
          {template.favorite ? "Remover dos favoritos" : "Favoritar"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            selectTemplate(id);
            goToView("playground");
          }}
        >
          Testar na API
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => downloadTemplate(id)}>Baixar</ContextMenuItem>
        {/* onSelect com preventDefault: o menu tem que ficar aberto para o "ID copiado" ser visto. */}
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault();
            copyText(id, `tpl-${id}`);
          }}
        >
          {s.copied === `tpl-${id}` ? "ID copiado" : "Copiar ID"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => askDeleteTemplate(id, name)}>
          Excluir
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
