import type { Doc, El } from "../types";

/**
 * Miniatura de um documento, desenhada a partir do PRÓPRIO documento — usada tanto pelo
 * seletor "Começar por um modelo" quanto pela tela "Gerar" (mesmos starters, mesma fonte).
 *
 * Podia ser um mock em SVG feito à mão para cada modelo, e seria menos código — mas aí o
 * seletor mostraria uma coisa e o editor abriria outra assim que alguém mexesse em
 * starterTemplates.ts. Derivar da mesma fonte é o que garante que o que você escolhe é o
 * que você recebe.
 *
 * Renderiza a página em tamanho real dentro de um `scale`, em vez de recalcular cada medida
 * em porcentagem: assim tamanho de fonte, raio e espessura encolhem na mesma proporção que
 * as posições, que é o que uma miniatura fiel exige.
 */
export function StarterPreview({ doc, width }: { doc: Doc; width: number }) {
  const page = doc.pages[0];
  const scale = width / page.w;

  return (
    <div
      className="overflow-hidden rounded-[3px]"
      style={{ width, height: page.h * scale, background: page.bg }}
      aria-hidden
    >
      <div
        style={{
          width: page.w,
          height: page.h,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "relative",
        }}
      >
        {page.els.map((element) => (
          <PreviewElement key={element.id} element={element} />
        ))}
      </div>
    </div>
  );
}

function PreviewElement({ element }: { element: El }) {
  const box: React.CSSProperties = {
    position: "absolute",
    left: element.x,
    top: element.y,
    width: element.w,
    height: element.h,
    borderRadius: element.radius || undefined,
  };

  if (element.type === "text") {
    return (
      <div
        style={{
          ...box,
          color: element.fill,
          fontFamily: element.font,
          fontSize: element.size,
          fontWeight: element.weight,
          lineHeight: element.lh,
          textAlign: element.align as React.CSSProperties["textAlign"],
          overflow: "hidden",
        }}
      >
        {element.text}
      </div>
    );
  }

  // A imagem em si não tem src num modelo novo — o que aparece é a moldura, que
  // é o rect logo atrás. Renderizar só ela evita um retângulo vazio por cima.
  if (element.type === "image") return null;

  return <div style={{ ...box, background: element.fill }} />;
}
