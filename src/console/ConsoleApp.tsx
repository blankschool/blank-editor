import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
  closeNamePrompt,
  confirmNamePrompt,
  enterView,
  runConfirmDialog,
  set,
  state,
  setNamePromptValue,
  useConsole,
  viewFromHash,
} from "./store";
import { Sidebar } from "./Sidebar";
import { TemplatesView } from "./TemplatesView";
import { PlaygroundView } from "./PlaygroundView";
import { ImportView } from "./ImportView";
import { KeysView } from "./KeysView";

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
          {d ? `Excluir o template "${d.name}"? Isso não pode ser desfeito.` : ""}
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
    // Lê `state.view`, não `s.view`: o store é um objeto mutável de identidade
    // fixa, então esta closure de efeito-único enxerga sempre o valor atual —
    // mas depender disso via a variável de render seria fácil de ler errado.
    function sync() {
      const view = viewFromHash();
      if (view !== state.view) enterView(view);
    }
    // Canonicaliza um "#/console" pelado (ou uma sub-rota velha/desconhecida) para a view
    // realmente mostrada, para barra de endereço, refresh e voltar/avançar concordarem.
    const view = viewFromHash();
    if (location.hash.startsWith("#/console") && location.hash !== `#/console/${view}`) {
      history.replaceState(null, "", `#/console/${view}`);
    }
    enterView(view);

    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
    // Roda uma vez: o console monta junto com o app e nunca desmonta (o router
    // troca as três views por display), então isto é setup de ciclo de vida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-tw-root className="flex min-h-screen flex-col bg-bg text-text">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {s.view === "templates" && <TemplatesView />}
          {s.view === "playground" && <PlaygroundView />}
          {s.view === "import" && <ImportView />}
          {s.view === "keys" && <KeysView />}
        </main>
      </div>
      <NamePromptDialog />
      <ConfirmDialog />
    </div>
  );
}
