import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileUp,
  Info,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { goToView, importTemplatePdf, openTemplateById, resetPdfImport, useConsole } from "./store";

/** "2,4 MB" — tamanho legível em pt-BR. */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

const STEPS = ["Enviando", "Lendo páginas", "Reconstruindo textos e fontes", "Criando design"] as const;

function ExportSteps() {
  const chips = ["Compartilhar", "Baixar", "Tipo de arquivo: PDF para impressão"];
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-xs font-medium text-muted">Como exportar do Canva</span>
      <ol className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
        {chips.map((chip, index) => (
          <li key={chip} className="flex items-center gap-1.5">
            {index > 0 && <ChevronRight size={12} strokeWidth={1.8} className="text-faint" aria-hidden />}
            <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-2 px-2.5 py-1 text-xs text-text">
              <span className="font-semibold text-accent">{index + 1}</span>
              {chip}
            </span>
          </li>
        ))}
      </ol>
      <span className="flex items-start gap-1.5 text-xs leading-relaxed text-faint">
        <Info size={14} strokeWidth={1.8} className="mt-px flex-none" aria-hidden />
        Não use PDF Padrão: as páginas saem como imagem e o texto deixa de ser editável.
      </span>
    </div>
  );
}

function DropZone({ onPick }: { onPick: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <label
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void importTemplatePdf(file);
      }}
      onClick={(event) => {
        event.preventDefault();
        onPick();
      }}
      className={cn(
        "flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-line px-6 py-8 text-center transition-colors hover:border-line-strong",
        over && "border-accent bg-accent-soft",
      )}
    >
      <FileUp size={32} strokeWidth={1.6} className={over ? "text-accent" : "text-muted"} aria-hidden />
      <div className="flex flex-col gap-1">
        <span className="font-display text-[15px] font-semibold">Arraste seu PDF aqui</span>
        <span className="text-xs text-faint">ou clique para escolher um arquivo · até 50 MB</span>
      </div>
      <Button size="lg" type="button" tabIndex={-1} className="pointer-events-none">
        Escolher PDF
      </Button>
    </label>
  );
}

function Progress() {
  const s = useConsole();
  const pct = s.pdfUploadPct;
  // Enquanto o envio não termina, estamos em "Enviando"; depois o servidor processa
  // tudo numa chamada só, então as etapas seguintes ficam como "em andamento".
  const uploading = pct !== null && pct < 100;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <FileText size={22} strokeWidth={1.6} className="flex-none text-accent" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium">{s.pdfImportFile?.name ?? "PDF"}</span>
          {s.pdfImportFile && <span className="text-xs text-faint">{formatBytes(s.pdfImportFile.size)}</span>}
        </div>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn("h-1 rounded-full bg-accent transition-[width]", !uploading && "animate-pulse")}
          style={{ width: uploading ? `${Math.max(4, pct ?? 0)}%` : "100%" }}
        />
      </div>
      <span aria-live="polite" className="text-xs text-muted">
        {uploading ? `Enviando… ${pct}%` : "Processando o PDF. Arquivos grandes podem levar um minuto."}
      </span>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
        {STEPS.map((step, index) => {
          const done = index === 0 && !uploading;
          const current = uploading ? index === 0 : index > 0;
          return (
            <li key={step} className={cn("flex items-center gap-2", done ? "text-muted" : current ? "text-text" : "text-faint")}>
              <span
                className={cn(
                  "h-1.5 w-1.5 flex-none rounded-full",
                  done ? "bg-accent" : current ? "animate-pulse bg-accent" : "bg-line-strong",
                )}
              />
              {step}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ErrorBlock({ onPick }: { onPick: () => void }) {
  const s = useConsole();
  const err = s.pdfImportError;
  if (!err) return null;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/5 p-4 text-xs">
      <AlertCircle size={16} strokeWidth={1.8} className="mt-px flex-none text-danger" aria-hidden />
      <div className="flex flex-1 flex-col gap-1.5">
        <strong className="text-[13px] font-semibold text-danger">Não conseguimos importar este PDF</strong>
        <span className="leading-relaxed text-muted">
          {err.codigo === "achatado"
            ? "Este PDF foi exportado como imagem. Exporte de novo pelo Canva com PDF para impressão."
            : err.message}
        </span>
        <Button variant="outline" size="sm" className="mt-1 self-start" onClick={onPick}>
          Escolher outro PDF
        </Button>
      </div>
    </div>
  );
}

function Result() {
  const s = useConsole();
  const r = s.pdfImportResult;
  const openRef = useRef<HTMLButtonElement>(null);
  const [coverBroken, setCoverBroken] = useState(false);
  useEffect(() => openRef.current?.focus(), [r?.id]);
  if (!r) return null;

  const subs = [...new Set(r.fontSubstitutions?.map((f) => `Fonte ${f.original} trocada por ${f.replacement}`) ?? [])];
  const pages = r.flaggedPages.map((page) => `Página ${page} veio como imagem (sem texto editável)`);
  const warnings = [...subs, ...pages];
  const counters = [
    [r.pageCount, r.pageCount === 1 ? "página" : "páginas"],
    [r.layerCount, r.layerCount === 1 ? "camada" : "camadas"],
    [r.fontCount, r.fontCount === 1 ? "fonte" : "fontes"],
  ] as const;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-4">
        <div className="flex h-24 w-24 flex-none items-center justify-center overflow-hidden rounded-md bg-inset p-1.5">
          {!coverBroken ? (
            <img
              src={`/api/v1/templates/${encodeURIComponent(r.id)}/cover`}
              alt=""
              onError={() => setCoverBroken(true)}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <FileText size={24} strokeWidth={1.5} className="text-faint" aria-hidden />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <span className="truncate font-display text-[15px] font-semibold">{r.name}</span>
          <div className="flex gap-2">
            {counters.map(([n, label]) => (
              <div key={label} className="flex flex-col rounded-md bg-surface-2 px-3 py-1.5">
                <span className="text-[15px] font-semibold tabular-nums">{n}</span>
                <span className="text-[11px] text-faint">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg bg-warning/10 p-3.5 text-xs">
          <AlertTriangle size={16} strokeWidth={1.8} className="mt-px flex-none text-warning" aria-hidden />
          <div className="flex flex-col gap-1.5">
            <strong className="text-[13px] font-semibold text-text">Revise antes de usar</strong>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-muted">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <Button ref={openRef} size="lg" onClick={() => openTemplateById(r.id)}>
          Abrir no editor
          <ArrowRight size={15} strokeWidth={1.8} />
        </Button>
        <Button variant="outline" size="lg" onClick={resetPdfImport}>
          <RotateCcw size={15} strokeWidth={1.8} />
          Importar outro PDF
        </Button>
      </div>
    </div>
  );
}

/**
 * A pessoa envia o PDF que o Canva exportou ("PDF para impressão") e recebe de volta um
 * design editável — texto, imagens e fontes já reconstruídos. Sem avisos, o store abre o
 * editor sozinho; com avisos, fica o cartão de resultado para revisar.
 */
export function ImportView() {
  const s = useConsole();
  const fileInput = useRef<HTMLInputElement>(null);
  const pick = () => fileInput.current?.click();

  return (
    <div className="flex max-w-[640px] flex-col gap-5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => goToView("designs")}
          className="flex items-center gap-1 rounded-sm py-1 pl-1 pr-2 text-xs text-faint hover:bg-surface-2 hover:text-text"
        >
          <ChevronLeft size={14} strokeWidth={1.6} />
          Designs
        </button>
        <span aria-hidden className="text-faint">
          /
        </span>
        <h1 className="font-display text-[15px] font-semibold -tracking-[0.01em]">Importar PDF</h1>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // escolher o MESMO arquivo de novo tem que disparar change outra vez
          if (file) void importTemplatePdf(file);
        }}
      />

      {s.pdfImportStatus === "processando" ? (
        <Progress />
      ) : s.pdfImportStatus === "pronto" && s.pdfImportResult ? (
        <Result />
      ) : (
        <>
          <ExportSteps />
          <ErrorBlock onPick={pick} />
          <DropZone onPick={pick} />
        </>
      )}
    </div>
  );
}
