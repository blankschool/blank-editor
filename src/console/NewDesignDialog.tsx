import { FilePlus2, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { StarterPreview } from "./DocPreview";
import { STARTERS, closeNewDesign, createFromStarter, useConsole, type Starter } from "./store";

function StarterCard({ starter }: { starter: Starter }) {
  const s = useConsole();
  const busy = s.creating === starter.id;
  const doc = starter.build();

  return (
    <button
      type="button"
      disabled={Boolean(s.creating)}
      onClick={() => createFromStarter(starter)}
      className={cn(
        "group flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5 text-left transition-[border-color,transform] duration-100",
        "hover:-translate-y-px hover:border-accent disabled:pointer-events-none",
        busy && "border-accent",
        s.creating && !busy && "opacity-50",
      )}
    >
      <div className="relative flex h-[188px] items-center justify-center rounded-md bg-inset p-3">
        <StarterPreview doc={doc} width={starter.ratio === "9 / 16" ? 92 : 130} />
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-[var(--overlay)]">
            <Loader2 size={18} className="animate-spin text-on-accent" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">{starter.label}</span>
          <span className="font-mono text-[10px] text-faint">{starter.sizeLabel}</span>
        </div>
        <span className="text-xs leading-relaxed text-faint">{starter.hint}</span>
      </div>

      {/* Os campos são a promessa do produto — é o que a API vai preencher —, então
          aparecem na escolha, não só depois de abrir o design. */}
      <div className="flex flex-wrap gap-1">
        {starter.fields.map((field) => (
          <span key={field} className="rounded-[5px] bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
            {field}
          </span>
        ))}
      </div>
    </button>
  );
}

export function NewDesignDialog() {
  const s = useConsole();

  return (
    <Dialog open={s.newDesignOpen} onOpenChange={(open) => !open && closeNewDesign()}>
      <DialogContent className="max-w-[1040px]">
        <div className="flex flex-col gap-1.5 pr-8">
          <DialogTitle className="text-[17px]">Começar por um modelo</DialogTitle>
          <DialogDescription>
            Cada modelo já vem com as camadas nomeadas — são elas que a API preenche depois.
          </DialogDescription>
        </div>

        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {STARTERS.map((starter) => (
            <StarterCard key={starter.id} starter={starter} />
          ))}
        </div>

        {s.createError && <span className="text-xs text-danger">{s.createError}</span>}

        <div className="flex items-center gap-3 border-t border-line pt-4">
          <span className="flex-1 text-xs text-faint">
            Prefere montar do zero? O canvas em branco continua aí.
          </span>
          <button
            type="button"
            disabled={Boolean(s.creating)}
            onClick={() => createFromStarter(null)}
            className="flex items-center gap-2 rounded-sm border border-line bg-surface-2 px-3.5 py-2 text-xs text-muted hover:border-line-strong hover:text-text disabled:opacity-50"
          >
            {s.creating === "blank" ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} strokeWidth={1.5} />}
            Começar em branco
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
