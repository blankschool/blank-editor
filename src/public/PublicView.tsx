import { useEffect, useState } from "react";

/**
 * Visão pública de um design compartilhado por link (`/#/p/<id>`) — sem sessão, sem console,
 * sem o editor pesado. Só busca `GET /api/v1/public/designs/:id` (metadados) e desenha um
 * `<img>` por página apontando pro PNG que o servidor já sabe renderizar
 * (`GET .../page/:n`, mesma função `renderTemplatePng` que a capa do dono usa) — nenhuma lógica
 * de canvas duplicada aqui, o servidor já fez o trabalho pesado.
 */
function idFromHash(): string | null {
  const match = /^#\/p\/([^/?]+)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

interface PublicDesign {
  id: string;
  name: string;
  pageCount: number;
}

export function PublicView() {
  const [id, setId] = useState<string | null>(idFromHash());
  const [design, setDesign] = useState<PublicDesign | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const onHashChange = () => setId(idFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setDesign(null);
    setNotFound(false);
    fetch(`/api/v1/public/designs/${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body) => { if (!cancelled) setDesign(body); })
      .catch(() => { if (!cancelled) setNotFound(true); });
    return () => { cancelled = true; };
  }, [id]);

  if (!id) return null;

  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-bg px-6 text-center">
        <h1 className="font-display text-[17px] font-semibold text-text">Este link não está disponível</h1>
        <p className="max-w-[360px] text-[13px] text-faint">
          O design não existe ou quem criou parou de compartilhar o link.
        </p>
      </div>
    );
  }

  if (!design) {
    return <div className="flex min-h-screen items-center justify-center bg-bg font-mono text-xs text-faint">carregando…</div>;
  }

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-inset px-4 py-10">
      <h1 className="font-display text-[17px] font-semibold text-text">{design.name}</h1>
      <div className="flex w-full max-w-[720px] flex-col items-center gap-6">
        {Array.from({ length: design.pageCount }, (_, i) => (
          <img
            key={i}
            src={`/api/v1/public/designs/${encodeURIComponent(design.id)}/page/${i + 1}`}
            alt={`${design.name} — página ${i + 1}`}
            className="w-full rounded-lg shadow-pop"
          />
        ))}
      </div>
    </div>
  );
}
