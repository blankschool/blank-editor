import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
  closeNamePrompt,
  confirmNamePrompt,
  openConsole,
  runConfirmDialog,
  set,
  setNamePromptValue,
  useConsole,
} from "./store";
import { AppHeader } from "./AppHeader";
import { NewDesignDialog } from "./NewDesignDialog";
import { Sidebar } from "./Sidebar";
import { DesignsView } from "./DesignsView";
import { AccountView } from "./AccountView";
import { PlaygroundView } from "./PlaygroundView";
import { ImportView } from "./ImportView";
import { KeysView } from "./KeysView";
import { DocsView } from "./DocsView";

function NamePromptDialog() {
  const s = useConsole();
  const p = s.namePrompt;

  return (
    <Dialog open={Boolean(p)} onOpenChange={(open) => !open && closeNamePrompt()}>
      <DialogContent className="max-w-[380px]" showClose={false}>
        <DialogTitle>{p?.title}</DialogTitle>
        <Input
          // autoFocus + select: o Radix já move o foco para o primeiro campo, mas
          // renomear abre com o nome atual preenchido e o texto tem que vir
          // selecionado para ser sobrescrito de uma vez.
          autoFocus
          value={p?.value ?? ""}
          onChange={(e) => setNamePromptValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmNamePrompt();
          }}
        />
        {p?.error && <span className="text-xs text-danger">{p.error}</span>}
        <DialogFooter>
          <Button variant="outline" size="lg" className="flex-1" onClick={closeNamePrompt}>
            Cancelar
          </Button>
          <Button size="lg" className="flex-1" disabled={!p?.value.trim()} onClick={confirmNamePrompt}>
            {p?.kind === "rename-template" ? "Renomear" : "Criar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog() {
  const s = useConsole();
  const d = s.confirmDialog;

  return (
    <Dialog open={Boolean(d)} onOpenChange={(open) => !open && set("confirmDialog", null)}>
      <DialogContent className="max-w-[380px]" showClose={false}>
        <span className="text-[13px] leading-relaxed">
          {d ? `Excluir o design “${d.name}”? Isso não pode ser desfeito.` : ""}
        </span>
        <DialogFooter>
          <Button variant="outline" size="lg" className="flex-1" onClick={() => set("confirmDialog", null)}>
            Cancelar
          </Button>
          <Button variant="danger" size="lg" className="flex-1" onClick={runConfirmDialog}>
            Excluir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConsoleApp() {
  const s = useConsole();

  useEffect(() => {
    // openConsole canonicaliza a URL e revalida; ele é chamado aqui, a cada
    // hashchange, e também pelo router em main.tsx quando esta view volta a
    // aparecer depois de uma ida ao editor.
    openConsole();
    window.addEventListener("hashchange", openConsole);
    return () => window.removeEventListener("hashchange", openConsole);
    // Roda uma vez: o console monta junto com o app e nunca desmonta (o router
    // troca as três views por display), então isto é setup de ciclo de vida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-tw-root className="flex h-screen flex-col bg-bg text-text">
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/* overflow-y no main, não no body: o body tem overflow:hidden por causa do
            editor, então sem isso a home com muitos designs não rola. */}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {s.view === "designs" && <DesignsView />}
          {s.view === "docs" && <DocsView />}
          {s.view === "account" && <AccountView />}
          {s.view === "playground" && <PlaygroundView />}
          {s.view === "import" && <ImportView />}
          {s.view === "keys" && <KeysView />}
        </main>
      </div>
      <NewDesignDialog />
      <NamePromptDialog />
      <ConfirmDialog />
    </div>
  );
}
