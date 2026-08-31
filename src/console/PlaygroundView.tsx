import { Copy, Image as ImageIcon, Pencil, Play, RefreshCw, Type, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { DevViewHeader } from "./AccountView";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  copyCode,
  filledLayers,
  goToView,
  openTemplateById,
  openPlaygroundInCanvas,
  preparePlaygroundApiKey,
  selectPage,
  selectTemplate,
  set,
  setLayerValue,
  setPlaygroundApiKey,
  snippetFor,
  startRender,
  uploadLayerPhoto,
  useConsole,
  type Lang,
} from "./store";

const LANGS: ReadonlyArray<{ value: Lang }> = [
  { value: "JavaScript" }, { value: "Python" }, { value: "cURL" }, { value: "PHP" },
];
const RESULT_TABS = [
  { value: "preview" as const, label: "Preview" },
  { value: "response" as const, label: "Response" },
];

function LayerField({ layer }: { layer: { id: number; type: "text" | "image"; name: string; value: string } }) {
  const Icon = layer.type === "text" ? Type : ImageIcon;
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line bg-inset p-3">
      <div className="flex items-center gap-2.5">
        <Icon size={14} strokeWidth={1.4} className="flex-none text-muted" />
        <label htmlFor={`layer-${layer.id}`} className="flex-1 font-mono text-xs text-text">
          {layer.name}
        </label>
      </div>
      <div className="flex items-center gap-1.5">
        {layer.type === "text" ? <Textarea
          id={`layer-${layer.id}`}
          value={layer.value}
          onChange={(e) => setLayerValue(layer.id, e.target.value)}
          placeholder="Texto dinâmico"
          rows={layer.value.length > 100 || layer.value.includes("\n") ? 4 : 2}
          className="resize-y font-sans text-sm"
        /> : <Input
          id={`layer-${layer.id}`}
          value={layer.value}
          onChange={(e) => setLayerValue(layer.id, e.target.value)}
          placeholder="URL da imagem"
          className="h-9.5"
        />}
        {layer.type === "image" && (
          <label
            title="Subir uma foto"
            className="flex h-9.5 w-9.5 flex-none cursor-pointer items-center justify-center rounded-md border border-line text-muted hover:border-line-strong hover:text-text"
          >
            <Upload size={14} strokeWidth={1.5} />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadLayerPhoto(layer.id, file);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}

export function PlaygroundView() {
  const s = useConsole();

  const previewText = s.rendering
    ? "Gerando render…"
    : s.rendered
      ? `render pronto · PNG real · ${filledLayers().length} campos`
      : "Preencha as camadas e clique em “Gerar render” para ver o resultado aqui.";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
      <DevViewHeader title="Playground" />
      <div className="grid min-h-0 flex-1 grid-cols-1 items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4.5">
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium">Template</span>
          {s.templates.length ? (
            <>
              <Select value={s.templateId} onValueChange={selectTemplate} disabled={s.playgroundOpening}>
                <SelectTrigger aria-label="Template">
                  <SelectValue placeholder="Escolha um template" />
                </SelectTrigger>
                <SelectContent>
                  {s.templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" onClick={() => openTemplateById(s.templateId)} disabled={s.playgroundOpening || s.rendering} className="border border-line">
                Editar template original
              </Button>
              <span className="text-xs leading-relaxed text-faint">Abre o modelo salvo, sem aplicar os campos deste teste.</span>
            </>
          ) : (
            <button
              type="button"
              onClick={() => goToView("designs")}
              className="rounded-sm border border-dashed border-line p-3 text-center text-xs text-faint hover:text-muted"
            >
              nenhum design ainda — crie um em Designs
            </button>
          )}
        </div>

        {/* Só para template de mais de uma página. É o que torna um carrossel
            utilizável pela API: mesma chamada, `page` diferente por slide. */}
        {s.templatePages > 1 && (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">Página</span>
            <Segmented
              aria-label="Página do template"
              value={String(s.page)}
              onValueChange={(v) => selectPage(Number(v))}
              options={Array.from({ length: s.templatePages }, (_, i) => ({ value: String(i + 1) }))}
            />
            <span className="text-xs text-faint">
              Cada página é um render. Os campos abaixo são os desta.
            </span>
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="apiKey" className="text-xs text-muted">
            API key
          </label>
          <Input
            id="apiKey"
            value={s.apiKey}
            onChange={(e) => setPlaygroundApiKey(e.target.value)}
            placeholder={s.apiKeyLoading ? "preparando chave padrão…" : "chave padrão da conta"}
            disabled={s.apiKeyLoading}
            className="h-9 font-mono text-[11px]"
          />
          <div className="flex items-center gap-2">
            <span className="flex-1 font-mono text-[10px] text-faint">POST /api/v1/render → {location.host}</span>
            {s.apiKeyError && (
              <button
                type="button"
                onClick={() => void preparePlaygroundApiKey()}
                className="flex items-center gap-1 text-[10px] text-danger hover:underline"
              >
                <RefreshCw size={11} />
                Tentar novamente
              </button>
            )}
          </div>
          {s.apiKeyLoading && <span className="text-[10px] text-faint">Criando e salvando a chave desta conta…</span>}
          {s.apiKeyError && <span role="alert" className="text-[10px] text-danger">{s.apiKeyError}</span>}
        </div>

        <span className="text-[13px] font-medium">Campos do template</span>

        <div className="flex flex-col gap-2.5">
          {s.layers.map((l) => (
            <LayerField key={l.id} layer={l} />
          ))}
          {s.layers.length === 0 && (
            <div className="rounded-md border border-dashed border-line p-5.5 text-center font-mono text-[11px] text-faint">
              nenhuma camada
            </div>
          )}
        </div>

        <span className="text-xs text-faint">
          Campos vêm do template selecionado. Imagens precisam de uma URL pública.
        </span>

        <label className="flex items-start gap-2.5 rounded-md border border-line bg-inset p-3 text-xs">
          <Checkbox
            checked={s.saveAsDesign}
            onCheckedChange={(v) => set("saveAsDesign", v === true)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-text">Sobrescrever template ao gerar</span>
            <span className="text-faint">
              Atualiza o template original com estes campos. Para preservar o modelo, deixe desligado e use “Editar resultado no canvas”.
            </span>
          </span>
        </label>

        <Button size="xl" onClick={startRender} disabled={s.rendering || s.playgroundOpening || s.apiKeyLoading || !s.playgroundDocument} className="rounded-md text-sm">
          <Play size={13} fill="currentColor" strokeWidth={0} />
          {s.rendering ? "Gerando…" : "Gerar render"}
        </Button>
        <Button variant="outline" onClick={() => openPlaygroundInCanvas()} disabled={s.rendering || s.playgroundOpening || !s.playgroundDocument}>
          <Pencil size={14} />
          {s.playgroundOpening ? "Abrindo cópia…" : "Editar campos no canvas"}
        </Button>
        <span className="text-xs leading-relaxed text-faint">Cria uma cópia com os campos atuais, mesmo sem gerar uma imagem.</span>
        {s.playgroundError && <p role="alert" className="text-sm text-danger">{s.playgroundError}</p>}
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          aria-label="Resultado"
          value={s.tab}
          onValueChange={(v) => set("tab", v)}
          options={RESULT_TABS}
          size="tab"
          className="self-start p-[5px]"
        />
        {s.renderedDocument && (
          <Button onClick={() => openPlaygroundInCanvas(true)} disabled={s.playgroundOpening || s.rendering}>
            <Pencil size={14} />
            {s.playgroundOpening ? "Abrindo cópia…" : "Editar resultado no canvas"}
          </Button>
        )}
        </div>

        {s.renderedDocument && <p className="text-xs leading-relaxed text-muted">
          O preview é uma imagem. Abra uma cópia com camadas editáveis e os valores da última geração, sem alterar o template original.
        </p>}

        {s.tab === "preview" ? (
          <div className="flex min-h-[380px] items-center justify-center rounded-lg border border-line bg-inset p-8 text-center">
            {s.previewUrl ? (
              <img
                src={s.previewUrl}
                alt="Preview do resultado gerado"
                className="block h-auto max-w-full rounded-sm"
              />
            ) : (
              <span className="max-w-[380px] text-sm leading-relaxed text-faint">{previewText}</span>
            )}
          </div>
        ) : (
          <pre className="min-h-[380px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-inset p-4.5 font-mono text-xs leading-relaxed text-muted">
            {s.response || "// sem resposta ainda — gere um render"}
          </pre>
        )}

        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-1">
            <Segmented
              aria-label="Linguagem do exemplo"
              value={s.lang}
              onValueChange={(v) => set("lang", v)}
              options={LANGS}
              size="tab"
              className="border-none bg-transparent p-0"
            />
            <div className="flex-1" />
            <Button variant="outline" onClick={copyCode}>
              <Copy size={13} strokeWidth={1.4} />
              {s.copiedCode ? "Copiado" : "Copiar"}
            </Button>
          </div>
          <pre className="overflow-auto rounded-lg border border-line bg-inset p-4.5 font-mono text-xs leading-[1.75] text-text">
            {snippetFor(s.lang)}
          </pre>
        </div>
      </div>
      </div>
    </div>
  );
}
