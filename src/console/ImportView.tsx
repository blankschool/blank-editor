import { useRef } from "react";
import { ChevronRight, FileDown, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
  APP_META,
  IMP_META,
  JSON_PLACEHOLDER,
  importTemplateJson,
  set,
  useConsole,
  type AppName,
  type ImpTab,
} from "./store";

const IMP_TABS: ReadonlyArray<{ value: ImpTab }> = [
  { value: "JSON" }, { value: "Imagens" }, { value: "Fontes" }, { value: "Apps" },
];

function JsonPanel() {
  return (
    <div className="flex max-w-[620px] flex-col gap-3.5 rounded-lg border border-line bg-surface p-4.5">
      <div className="flex items-center gap-2.5">
        <FileDown size={18} strokeWidth={1.7} className="flex-none text-text" />
        <span className="flex-1 text-sm font-medium">Importar JSON</span>
      </div>
      <span className="text-xs leading-relaxed text-faint">
        Cole ou envie um arquivo .json com o mesmo formato que o editor salva (um documento com
        "pages"). Ele vira um template novo, editável no canvas.
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
        Importar JSON
      </Button>
    </div>
  );
}

function openApp(app: AppName) {
  set("appUrl", "");
  set("appDoc", null);
  set("app", app);
}

function AppsPanel() {
  return (
    <div className="grid max-w-[860px] grid-cols-2 gap-4">
      {(["Canva", "Figma"] as const).map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => openApp(name)}
          className="flex flex-col gap-3.5 rounded-lg border border-line bg-surface p-4.5 text-left hover:border-line-strong"
        >
          <div className="flex items-center gap-3">
            <div className="h-9.5 w-9.5 flex-none rounded-md border border-line-strong bg-avatar" />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">{name}</span>
              <span className="font-mono text-[10px] text-faint">
                {name === "Canva" ? "conectado" : "conectar"}
              </span>
            </div>
            <ChevronRight size={15} strokeWidth={1.4} className="text-faint" />
          </div>
          <span className="text-xs leading-relaxed text-faint">
            {name === "Canva"
              ? "Importar um design ou pasta compartilhada."
              : "Colar link do frame ou arquivo."}
          </span>
        </button>
      ))}
    </div>
  );
}

function UrlPanel({ tab }: { tab: ImpTab }) {
  const s = useConsole();
  const meta = IMP_META[tab] ?? IMP_META.Imagens;

  return (
    <div className="flex max-w-[860px] flex-col gap-3.5 rounded-lg border border-line bg-surface p-4.5">
      <div className="flex flex-col gap-2">
        <label htmlFor="importUrl" className="text-xs text-muted">
          Importar por link
        </label>
        <div className="flex gap-2.5">
          <Input
            id="importUrl"
            value={s.importUrl}
            onChange={(e) => set("importUrl", e.target.value)}
            placeholder={meta.placeholder}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            size="lg"
            className="flex-none"
            onClick={() => {
              const url = s.importUrl.trim();
              if (!url) return;
              set("importUrl", "");
              set("lastAdded", "link · " + (url.split("/").pop() || url));
            }}
          >
            Importar
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => set("lastAdded", "arquivo local · aguardando upload")}
        className="flex flex-col items-center gap-2.5 rounded-md border border-dashed border-line bg-inset p-11 text-center hover:border-line-strong"
      >
        <Upload size={22} strokeWidth={1.2} className="text-faint" />
        <span className="text-[13px] text-muted">Arraste arquivos ou clique para selecionar</span>
        <span className="font-mono text-[11px] text-faint">{meta.accept}</span>
      </button>
      <span className="text-xs text-faint">{s.lastAdded || "Nada importado nesta sessão."}</span>
    </div>
  );
}

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

function AppModal() {
  const s = useConsole();
  const app = s.app ? APP_META[s.app] : null;

  return (
    <Dialog open={Boolean(s.app)} onOpenChange={(open) => !open && set("app", null)}>
      <DialogContent className="max-w-[460px]" showClose={false}>
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <DialogTitle className="text-sm">Importar do {s.app}</DialogTitle>
            <span className="text-xs text-faint">{app?.hint}</span>
          </div>
        </div>

        <Input
          aria-label="Link"
          value={s.appUrl}
          onChange={(e) => set("appUrl", e.target.value)}
          placeholder={app?.placeholder}
          className="font-mono text-xs"
        />

        <div className="flex flex-col gap-2">
          {app?.docs.map((doc) => (
            <button
              key={doc.name}
              type="button"
              onClick={() => set("appDoc", doc.name)}
              aria-pressed={s.appDoc === doc.name}
              className={`flex items-center gap-2.5 rounded-sm border bg-surface-2 px-3 py-2.5 text-left ${
                s.appDoc === doc.name ? "border-line-strong" : "border-line"
              }`}
            >
              <div className="h-6.5 w-6.5 flex-none rounded-sm border border-line-strong bg-avatar" />
              <span className="flex-1 text-xs">{doc.name}</span>
              <span className="font-mono text-[10px] text-faint">{doc.meta}</span>
            </button>
          ))}
        </div>

        <DialogFooter>
          <span className="flex-1 font-mono text-[10px] text-faint">oauth · somente leitura</span>
          <Button variant="outline" size="md" onClick={() => set("app", null)}>
            Cancelar
          </Button>
          <Button
            size="md"
            onClick={() => {
              set("lastAdded", `${s.app} · ${s.appDoc || s.appUrl || "importação iniciada"}`);
              set("app", null);
            }}
          >
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
      <div className="flex min-h-0 flex-1 flex-col gap-4.5 p-5">
        <div className="flex flex-col gap-1.5">
          <span className="font-display text-[15px] font-semibold">Importar</span>
          <span className="text-xs text-faint">Textos, imagens, fontes e designs de outros apps.</span>
        </div>
        <Segmented
          aria-label="Tipo de importação"
          value={s.impTab}
          onValueChange={(v) => set("impTab", v)}
          options={IMP_TABS}
          size="tab"
          className="self-start p-[5px]"
        />
        {s.impTab === "JSON" ? <JsonPanel /> : s.impTab === "Apps" ? <AppsPanel /> : <UrlPanel tab={s.impTab} />}
      </div>
      <JsonModal />
      <AppModal />
    </>
  );
}
