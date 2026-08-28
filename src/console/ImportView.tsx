import { useRef } from "react";
import { FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { DevViewHeader } from "./AccountView";
import { JSON_PLACEHOLDER, importTemplateJson, set, useConsole } from "./store";

/**
 * Só JSON.
 *
 * Esta tela tinha quatro abas — JSON, Imagens, Fontes, Apps (Canva/Figma). Três
 * delas não importavam nada: escreviam uma string em `state.lastAdded` e
 * pronto, sem upload, sem OAuth, sem endpoint do outro lado. Eram maquete. Como
 * a tela agora vive em Conta → Desenvolvedor e se chama "Importar JSON", manter
 * três importadores falsos ali era juntar o pior dos dois lados: superfície de
 * demo dentro da área técnica. Saíram — estão no histórico do git se voltarem a
 * fazer sentido com backend por trás.
 */
function JsonModal() {
  const s = useConsole();
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <Dialog open={s.jsonModalOpen} onOpenChange={(open) => set("jsonModalOpen", open)}>
      <DialogContent className="max-w-[640px]">
        <DialogTitle className="flex items-center gap-2.5 pr-8 text-[17px]">
          <FileDown size={20} strokeWidth={1.8} className="flex-none" />
          Importar JSON
        </DialogTitle>

        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-line bg-inset p-5 text-center hover:border-line-strong"
        >
          <span className="text-[13px] text-muted">Clique para escolher um arquivo .json</span>
          <span className="font-mono text-[11px] text-faint">ou cole o conteúdo abaixo</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            set("jsonError", null);
            set("jsonDraft", await file.text());
            // Zera o input: escolher o MESMO arquivo de novo tem que disparar change outra vez.
            event.target.value = "";
          }}
        />

        <Textarea
          aria-label="Documento JSON"
          spellCheck={false}
          value={s.jsonDraft}
          placeholder={JSON_PLACEHOLDER}
          onChange={(e) => {
            set("jsonError", null);
            set("jsonDraft", e.target.value);
          }}
          className="min-h-[260px] resize-y"
        />
        {s.jsonError && <span className="text-xs text-danger">{s.jsonError}</span>}

        <DialogFooter>
          <span className="flex-1 font-mono text-[11px] text-faint">
            {s.jsonDraft.trim() ? "pronto para importar" : "nada colado ainda"}
          </span>
          <Button variant="outline" size="lg" onClick={() => set("jsonModalOpen", false)}>
            Cancelar
          </Button>
          <Button size="lg" disabled={!s.jsonDraft.trim()} onClick={importTemplateJson}>
            <FileDown size={15} strokeWidth={1.8} />
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportView() {
  const s = useConsole();

  return (
    <>
      <div className="flex max-w-[620px] flex-col gap-5 p-5">
        <DevViewHeader title="Importar JSON" />

        <div className="flex flex-col gap-3.5 rounded-lg border border-line bg-surface p-4.5">
          <span className="text-xs leading-relaxed text-faint">
            Um arquivo .json no mesmo formato que o editor salva — um documento com{" "}
            <code className="font-mono text-[11px] text-muted">pages</code>. Ele entra como design novo, já
            editável no canvas.
          </span>
          <Button
            size="lg"
            className="self-start"
            onClick={() => {
              set("jsonError", null);
              set("jsonModalOpen", true);
            }}
          >
            <FileDown size={15} strokeWidth={1.8} />
            Escolher arquivo ou colar
          </Button>
          {s.lastAdded && <span className="text-xs text-faint">{s.lastAdded}</span>}
        </div>
      </div>
      <JsonModal />
    </>
  );
}
