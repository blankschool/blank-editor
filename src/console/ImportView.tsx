import { useRef } from "react";
import { CheckCircle2, FileWarning, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DevViewHeader } from "./AccountView";
import { importTemplatePdf, openTemplateById, set, useConsole } from "./store";

/**
 * Substitui o antigo "Importar JSON": em vez de colar o formato interno do
 * editor, a pessoa envia o PDF que o Canva exportou (Compartilhar → Baixar →
 * "PDF para impressão" — não "PDF Padrão", que sai achatado) e recebe de
 * volta um design editável de verdade — texto, imagens e fontes já
 * reconstruídos, sem passo manual nenhum.
 */
export function ImportView() {
  const s = useConsole();
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = s.pdfImportStatus === "processando";

  return (
    <div className="flex max-w-[620px] flex-col gap-5 p-5">
      <DevViewHeader title="Importar PDF" />

      <div className="flex flex-col gap-3.5 rounded-lg border border-line bg-surface p-4.5">
        <span className="text-xs leading-relaxed text-faint">
          Um PDF exportado do Canva (Compartilhar → Baixar →{" "}
          <code className="font-mono text-[11px] text-muted">PDF para impressão</code>). Texto, imagens
          e fontes chegam já editáveis, num design novo.
        </span>

        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = ""; // escolher o MESMO arquivo de novo tem que disparar change outra vez
            if (file) importTemplatePdf(file);
          }}
        />

        <Button
          size="lg"
          className="self-start"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? <Loader2 size={15} strokeWidth={1.8} className="animate-spin" /> : <Upload size={15} strokeWidth={1.8} />}
          {busy ? "Extraindo o PDF…" : "Escolher PDF"}
        </Button>

        {s.pdfImportStatus === "erro" && s.pdfImportError && (
          <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            <FileWarning size={15} strokeWidth={1.8} className="mt-0.5 flex-none" />
            <div className="flex flex-col gap-1">
              <span>{s.pdfImportError.message}</span>
              {s.pdfImportError.codigo === "achatado" && (
                <span className="text-faint">
                  Reexporte do Canva usando Compartilhar → Baixar → "PDF para impressão" (não "PDF Padrão"),
                  que exporta cada página achatada como uma imagem única.
                </span>
              )}
            </div>
          </div>
        )}

        {s.pdfImportStatus === "pronto" && s.pdfImportResult && (
          <div className="flex flex-col gap-2.5 rounded-md border border-line bg-inset p-3.5 text-xs">
            <div className="flex items-center gap-2 text-muted">
              <CheckCircle2 size={15} strokeWidth={1.8} className="flex-none text-accent" />
              <span>
                “{s.pdfImportResult.name}” importado: {s.pdfImportResult.pageCount}{" "}
                {s.pdfImportResult.pageCount === 1 ? "página" : "páginas"}, {s.pdfImportResult.layerCount}{" "}
                {s.pdfImportResult.layerCount === 1 ? "camada" : "camadas"}
                {s.pdfImportResult.fontCount > 0
                  ? `, ${s.pdfImportResult.fontCount} ${s.pdfImportResult.fontCount === 1 ? "fonte" : "fontes"}`
                  : ""}.
              </span>
            </div>
            {[...new Set(s.pdfImportResult.fontSubstitutions?.map(f => `${f.original} → ${f.replacement}`) ?? [])].map(change => (
              <span key={change} className="text-faint">Fonte substituída: {change}</span>
            ))}
            {s.pdfImportResult.flaggedPages.length > 0 && (
              <span className="text-faint">
                {s.pdfImportResult.flaggedPages.length === 1 ? "A página" : "As páginas"}{" "}
                {s.pdfImportResult.flaggedPages.join(", ")} veio achatada (sem texto/camadas) — confira se algo
                ficou faltando.
              </span>
            )}
            <Button
              size="default"
              className="self-start"
              onClick={() => s.pdfImportResult && openTemplateById(s.pdfImportResult.id)}
            >
              Abrir no editor
            </Button>
          </div>
        )}

        {s.lastAdded && s.pdfImportStatus === "idle" && <span className="text-xs text-faint">{s.lastAdded}</span>}
      </div>
    </div>
  );
}
