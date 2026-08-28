import { Check, FileEdit, Loader2, Save, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import {
  commitGerarLayerEdit,
  goToView,
  openGeneratedInEditor,
  runGerarGenerate,
  saveGeneratedAsNewDesign,
  selectGerarSource,
  setGerarActivePage,
  setGerarLayerValue,
  setGerarTheme,
  useConsole,
} from "./store";

/** Faixa de modelos: só os designs já salvos da conta — Gerar escreve em cima de um template
 *  que já existe, nunca inventa um layout do zero (isso é o "Começar por um modelo", em Designs).
 *  Escolher qualquer um zera a geração anterior (store.ts). */
function ModelStrip() {
  const s = useConsole();

  if (s.templates.length === 0) {
    return (
      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-medium">Escolha o modelo</span>
        <button
          type="button"
          onClick={() => goToView("designs")}
          className="rounded-sm border border-dashed border-line p-3 text-center text-xs text-faint hover:text-muted"
        >
          nenhum design ainda — crie um em Designs
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-[13px] font-medium">Escolha o modelo</span>
      <div className="flex flex-wrap gap-2.5">
        {s.templates.map((t) => {
          const active = s.gerarSource?.templateId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => selectGerarSource({ templateId: t.id, name: t.name })}
              className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors ${
                active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong"
              }`}
            >
              <span className="text-xs font-medium">{t.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LayerField({ page, name, value }: { page: number; name: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-inset p-2.5">
      <label className="font-mono text-[11px] text-muted">{name}</label>
      <textarea
        value={value}
        onChange={(e) => setGerarLayerValue(page, name, e.target.value)}
        onBlur={() => commitGerarLayerEdit(page)}
        rows={value.length > 60 ? 3 : 1}
        className="min-w-0 resize-none rounded-sm border border-line bg-surface px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
      />
    </div>
  );
}

export function GerarView() {
  const s = useConsole();
  const active = s.gerarPages.find((p) => p.page === s.gerarActivePage) ?? s.gerarPages[0];
  const canGenerate = Boolean(s.gerarSource) && s.gerarTheme.trim().length > 0 && !s.gerarGenerating;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 p-5">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[17px] font-semibold -tracking-[0.01em]">Gerar</h1>
        <span className="text-xs text-faint">Escolha um modelo, escreva o tema, e deixe a IA preencher os campos.</span>
      </div>

      <ModelStrip />

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium">Sobre o que é esse post?</span>
        <textarea
          value={s.gerarTheme}
          onChange={(e) => setGerarTheme(e.target.value)}
          placeholder="Ex: Black Friday da loja X, tom direto, 3 slides"
          rows={2}
          className="min-w-0 resize-none rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-accent"
        />
        <Button size="lg" onClick={runGerarGenerate} disabled={!canGenerate} className="w-fit rounded-md text-sm">
          {s.gerarGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} strokeWidth={1.8} />}
          {s.gerarGenerating ? "Gerando…" : "Gerar"}
        </Button>
        {s.gerarError && <span className="text-xs text-danger">{s.gerarError}</span>}
      </div>

      {s.gerarPages.length > 0 && (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-5">
          <div className="flex min-w-0 flex-col gap-3">
            {s.gerarPages.length > 1 && (
              <Segmented
                aria-label="Página"
                value={String(s.gerarActivePage)}
                onValueChange={(v) => setGerarActivePage(Number(v))}
                options={s.gerarPages.map((p) => ({ value: String(p.page) }))}
              />
            )}
            <div className="flex flex-1 items-center justify-center rounded-lg border border-line bg-inset p-6">
              {active && (
                <img src={active.previewUrl} alt={`Página ${active.page} gerada`} className="block max-h-[560px] max-w-full rounded-sm" />
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-[13px] font-medium">Campos gerados</span>
            <span className="text-xs text-faint">Corrija à mão se quiser — grava sozinho ao sair do campo.</span>
            <div className="flex flex-col gap-2.5 overflow-y-auto">
              {active && Object.entries(active.layers).map(([name, value]) => (
                <LayerField key={name} page={active.page} name={name} value={value} />
              ))}
            </div>

            <div className="mt-2 flex flex-col gap-2">
              <Button variant="outline" onClick={openGeneratedInEditor} className="rounded-md text-sm">
                <FileEdit size={14} strokeWidth={1.6} />
                Abrir no editor
              </Button>
              <Button onClick={saveGeneratedAsNewDesign} className="rounded-md text-sm">
                {s.gerarSaved ? <Check size={14} strokeWidth={2} /> : <Save size={14} strokeWidth={1.6} />}
                {s.gerarSaved ? "Salvo em Seus designs" : "Salvar como design novo"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
