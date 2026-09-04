import { Eye, EyeOff, FileEdit, Image as ImageIcon, Layers3, Loader2, RefreshCw, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import {
  commitGerarPageEdit,
  goToView,
  openGeneratedInEditor,
  regenerateGerarImage,
  runGerarGenerate,
  selectGerarSource,
  setGerarActivePage,
  setGerarImageValue,
  setGerarImageStrategy,
  setGerarFixedVisibility,
  setGerarLayerValue,
  setGerarTheme,
  uploadGerarImage,
  useConsole,
} from "./store";

/** Nome de exibição pros campos gerados — a chave (displayName, handle...) é o nome real da
 *  camada no template e não muda, só o rótulo mostrado aqui. Chave sem tradução cai no nome cru. */
const FIELD_LABELS: Record<string, string> = {
  displayName: "Nome de exibição",
  handle: "Usuário",
  tweetText: "Texto do post",
  avatar: "Avatar",
  media: "Imagem do post",
  verifiedBadge: "Selo verificado",
};

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
      <label className="font-mono text-[11px] text-muted">{FIELD_LABELS[name] ?? name}</label>
      <textarea
        value={value}
        onChange={(e) => setGerarLayerValue(page, name, e.target.value)}
        onBlur={() => commitGerarPageEdit(page)}
        rows={value.length > 60 ? 3 : 1}
        className="min-w-0 resize-none rounded-sm border border-line bg-surface px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
      />
    </div>
  );
}

/** Imagens chegam do provedor escolhido e continuam substituíveis à mão por URL ou upload.
 * Upload já grava sozinho; URL grava ao sair do campo. */
function ImageLayerField({ page, name, value }: { page: number; name: string; value: string }) {
  const s = useConsole();
  const regenerating = s.gerarRegenerating === `${page}:${name}`;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-inset p-2.5">
      <div className="flex items-center gap-2">
        <ImageIcon size={13} strokeWidth={1.5} className="flex-none text-muted" />
        <label className="font-mono text-[11px] text-muted">{FIELD_LABELS[name] ?? name}</label>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => setGerarImageValue(page, name, e.target.value)}
          onBlur={() => commitGerarPageEdit(page)}
          placeholder="URL da imagem"
          className="h-9 min-w-0 flex-1 rounded-sm border border-line bg-surface px-2 text-sm text-text outline-none focus:border-accent"
        />
        <label
          title="Subir uma foto"
          className="flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-sm border border-line text-muted hover:border-line-strong hover:text-text"
        >
          <Upload size={13} strokeWidth={1.5} />
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadGerarImage(page, name, file);
              e.target.value = "";
            }}
          />
        </label>
        <button
          type="button"
          title={`Gerar outra imagem usando ${s.gerarImageStrategy === "stock" ? "banco de fotos" : "IA"}`}
          aria-label={`Gerar outra imagem para ${FIELD_LABELS[name] ?? name}`}
          disabled={Boolean(s.gerarRegenerating)}
          onClick={() => regenerateGerarImage(page, name)}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-sm border border-line text-muted hover:border-line-strong hover:text-text disabled:opacity-50"
        >
          <RefreshCw size={13} strokeWidth={1.5} className={regenerating ? "animate-spin" : ""} />
        </button>
      </div>
    </div>
  );
}

function FixedLayerField({ page, element }: { page: number; element: { id: string; name: string; type: string; hidden: boolean } }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-inset p-2.5">
      <Layers3 size={14} strokeWidth={1.5} className="flex-none text-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs text-text">{element.name}</span>
        <span className="text-[10px] capitalize text-faint">{element.type} · vem do modelo</span>
      </div>
      <button
        type="button"
        onClick={() => setGerarFixedVisibility(page, element.id, !element.hidden)}
        aria-label={`${element.hidden ? "Mostrar" : "Ocultar"} ${element.name}`}
        aria-pressed={!element.hidden}
        className="flex h-8 w-8 flex-none items-center justify-center rounded-sm border border-line text-muted hover:border-line-strong hover:text-text"
      >
        {element.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">Fonte das imagens</span>
          <Segmented
            aria-label="Fonte das imagens"
            value={s.gerarImageStrategy}
            onValueChange={setGerarImageStrategy}
            options={[
              { value: "stock", label: "Banco de fotos", title: "Fotos licenciadas do Pexels" },
              { value: "ai", label: "Gerar com IA", title: "Imagem criada para este post" },
            ]}
          />
        </div>
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
            <span className="text-xs leading-relaxed text-faint">As imagens são copiadas para o Blank. Você pode trocar a fonte, regenerar só este card, colar uma URL ou fazer upload.</span>
            <div className="flex flex-col gap-2.5 overflow-y-auto">
              {active && Object.entries(active.layers).map(([name, value]) => (
                <LayerField key={name} page={active.page} name={name} value={value} />
              ))}
              {active && Object.entries(active.images).map(([name, value]) => (
                <ImageLayerField key={name} page={active.page} name={name} value={value} />
              ))}
              {active && (active.fixed?.length ?? 0) > 0 && (
                <div className="mt-1 flex flex-col gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Elementos do modelo</span>
                  <span className="text-xs leading-relaxed text-faint">Formas e decorações não são criadas pela IA. Oculte aqui o que não deve entrar no resultado.</span>
                  {active.fixed.map((element) => (
                    <FixedLayerField key={element.id} page={active.page} element={element} />
                  ))}
                </div>
              )}
            </div>

            <div className="mt-2 flex flex-col gap-2">
              <Button variant="outline" onClick={openGeneratedInEditor} className="rounded-md text-sm">
                <FileEdit size={14} strokeWidth={1.6} />
                Abrir no editor
              </Button>
              <Button onClick={() => active && commitGerarPageEdit(active.page)} className="rounded-md text-sm">
                <RefreshCw size={14} strokeWidth={1.6} />
                Atualizar preview
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
