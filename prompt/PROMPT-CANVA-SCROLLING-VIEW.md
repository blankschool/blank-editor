# TAREFA: trocar o canvas Figma por documento Canva (scrolling view de verdade)

Leia isto até o fim antes de editar qualquer arquivo.
Não improvise arquitetura. Não “aproxime”. Implemente exatamente o modelo abaixo.

## Contexto do produto

Este app é um editor visual (`blank-editor`, Vite, `src/editor.ts`, `src/styles.css`, `index.html`).
Hoje o centro é um InfiniteCanvas estilo Figma: câmera livre (pan + zoom) com páginas como nodes no mundo.

O usuário quer o centro igual ao Canva Scrolling view:
páginas empilhadas numa coluna, o PRÓPRIO canvas rola entre elas, zoom escala o documento, sem plano infinito.

Referência visual do painel (índice, NÃO o editor): o HTML `canva-pages-nav.html`.
Referência do canvas certo: páginas no centro, wheel troca de página, zoom out não perde as páginas no cinza.

URL local de referência: `http://localhost:5173/#/editor/...`
Projeto aberto no vídeo: “Tweet Hollywood creators”, 2 páginas (tweet + página preta), barra inferior com zoom / Ajustar / 1/2 / miniaturas / grade.

## O que está ERRADO agora (não repetir)

A última implementação fez isto e está recusada:

1. Chamou de “Lista / scrolling view” um painel novo no slot `#panel` do rail.
   Isso NÃO é scrolling view. É um índice lateral.
2. Deixou o canvas central com câmera Figma.
   Wheel/pinch ainda muda `camera.scale`.
   Em ~14% de zoom as duas páginas viram selos no cinza infinito.
3. Criou 3 “modos” na barra inferior, mas o modo lista não mudou o input do canvas.
4. Extrair ações para `src/editor.ts` (mover/ocultar/duplicar/excluir) está ok.
   O problema não são as ações. É a VIEWPORT.

Proibido nesta tarefa:
- Reaproveitar `#panel` como se fosse scrolling view.
- Dizer que a tarefa está feita se o rail listar páginas e o centro continuar InfiniteCanvas.
- Adicionar um quarto modo.
- Criar componente irmão do tipo `PagesListPanel` + `InfiniteCanvas` lado a lado e chamar o primeiro de scrolling view.
- Wheel padrão fazendo zoom.
- camera.x / camera.y sem clamp (mundo infinito).
- Tratar páginas como frames soltos que podem ir para qualquer x/y do mundo.

## O que é scrolling view (definição fechada)

Scrolling view = comportamento do CANVAS CENTRAL.

- As artboards vivem numa coluna vertical no meio da área cinza.
- `page[i].y = i * (pageHeight + GAP)` no espaço do documento.
- `page[i].x` centraliza a coluna na viewport (mais um panX clampado).
- O usuário anda no documento com scroll (wheel sem modifier, trackpad, barra, space+drag clampado no eixo Y).
- Zoom (ctrl/cmd+wheel, pinch, botões − / +) escala a COLUNA inteira.
- Ao dar zoom out, as páginas continuam empilhadas e alinhadas. Nunca dois retângulos perdidos no vazio.
- O rail e a faixa de miniaturas são só índices: clicou → rola o canvas até aquela página.

Faixa de miniaturas (thumbnail view) e grade (grid view) podem existir.
Elas NÃO substituem o documento. Grid é overlay; ao fechar, volta ao documento com scroll.

## Modelo de dados / viewport

Introduza (ou substitua a câmera livre por) isto. Nomes podem variar, a semântica não.

```ts
type EditorView = {
  mode: "document" | "thumbs" | "grid";
  zoom: number;          // 0.1 a 3.0
  scrollY: number;       // px no espaço do documento (não mundo infinito)
  panX: number;          // deslocamento horizontal clampado
  activePageId: string;
};

const PAGE_GAP = 48; // px no espaço do documento, similar ao Canva
```

Posição de cada página no documento (antes da câmera/zoom):

```ts
function documentY(index: number, pageHeight: number) {
  return index * (pageHeight + PAGE_GAP);
}
```

Mapeamento tela ← documento:

```ts
// variante A — manter um transform único no stack
stack.style.transform = `translate(${panX}px, ${-scrollY}px) scale(${zoom})`;
stack.style.transformOrigin = "top center";

// variante B — se hoje cada página é um node absoluto
page.screenX = (viewportW / zoom - pageW) / 2 + panX;
page.screenY = documentY(i, pageH) - scrollY;
```

Prefira a variante A: um `.canvas-viewport` com overflow e um `.page-stack` interno.
Se já existe câmera, REAPROVEITE o objeto mas mude a semântica:
- `camera.y` vira `scrollY`
- `camera.x` vira `panX` clampado
- `camera.scale` vira `zoom` do documento
- DELETE qualquer movimento livre em X/Y sem limite

Clamp obrigatório:

```ts
const docHeight = pages.length * pageH + (pages.length - 1) * PAGE_GAP;
const maxScrollY = Math.max(0, docHeight * zoom - viewportH);
scrollY = clamp(scrollY, -margin, maxScrollY + margin);
panX = clamp(panX, -pageW * 0.25, pageW * 0.25);
```

Margem pequena (tipo 80–160px) é ok. Plano infinito não é.

`activePageId` é DERIVADO do scroll, não um estado isolado:

```ts
function pageIndexAt(scrollY: number) {
  const yDoc = (scrollY + viewportH / 2) / zoom;
  return clamp(Math.round(yDoc / (pageH + PAGE_GAP)), 0, pages.length - 1);
}
```

A barra inferior `1 / N` usa esse índice.
Trocar de página pelos thumbs/rail/grade atualiza `scrollY` para deixar a página alvo no centro (ou no topo com padding), e só então o índice muda.

## Input — tabela fechada

Implemente exatamente:

| Gesto | Resultado |
|---|---|
| Wheel / trackpad sem ctrl/cmd | `scrollY += deltaY` (documento). preventDefault no canvas. |
| Ctrl/Cmd + wheel | `zoom *= fator`. Origin: ponto sob o cursor OU centro da viewport. Recalcule scrollY para o ponto âncora não saltar. |
| Pinch | igual zoom. |
| Botões − / + da barra | zoom em passos (ex. 10%). |
| Ajustar | zoom + scrollY para a página ativa caber na viewport com padding. |
| Arrastar o CINZA com ferramenta de mão, space+drag ou botão do meio | pan: Y mexe scrollY, X mexe panX, ambos clampados. |
| Arrastar DENTRO da artboard com ferramenta selecionar | move elemento da página, coordenadas LOCAIS da página. Não pan da câmera. |
| Clique numa página | selectedPage = essa página; não recentraliza à força se já estiver visível. |
| Clique miniatura no rail ou na faixa | `scrollToPage(id)` no canvas. |
| Escape na grade | fecha overlay, volta ao documento. |

NUNCA:
- wheel sem modifier → zoom
- pinch → pan livre no infinito
- clicar no cinza longe das páginas e “voar” para o nada

Zoom âncora (obrigatório para não pular a página):

```ts
function zoomAt(nextZoom: number, anchorScreenX: number, anchorScreenY: number) {
  const docX = (anchorScreenX - panX) / zoom;
  const docY = (anchorScreenY + scrollY) / zoom;
  zoom = clamp(nextZoom, 0.1, 3);
  // reaplica âncora
  scrollY = docY * zoom - anchorScreenY;
  panX = anchorScreenX - docX * zoom;
  clampView();
}
```

## Onde cada UI vive

### Canvas central (obrigatório, isto É o scrolling view)
- Coluna de artboards
- Cabeçalho de cada página no canvas: “Página N”, setas, olho, duplicar, excluir
- Botão “+ Adicionar página” DEPOIS da última artboard, no fluxo do documento (já existe no vídeo — mantenha no fluxo, não num overlay solto)
- Ferramentas flutuantes de desenho podem continuar

### Rail esquerdo
- Abas atuais (Texto, Formas, Imagens, etc.) continuam donas do `#panel`
- Pode existir um item “Páginas” que abre o índice de miniaturas no `#panel`
- Esse índice é OPCIONAL e é só navegação
- Abrir Formas FECHA o índice de páginas e mostra formas de novo
- Nunca descreva esse painel como scrolling view

### Barra inferior
Mantenha o seletor, mas corrija o significado:

- Ícone lista / documento: não abre painel. Só garante `mode = "document"` (já é o padrão do canvas). Se o canvas já está em documento, o botão é estado ativo, não um panel toggle.
- Ícone faixa: mostra/esconde a tira horizontal de miniaturas no rodapé. O canvas continua documento.
- Ícone grade: overlay grid view em tela cheia. z-index da barra inferior > z-index da grade (você já subiu para 26 — mantenha).
- Zoom − % + / Ajustar / `i / N` / fullscreen: permanecem.

Não invente um quarto botão.

### Cabeçalhos flutuantes no canvas
Continue usando as funções compartilhadas já extraídas em `src/editor.ts`:
mover, ocultar, duplicar, excluir, adicionar.
Não duplique a lógica no rail e na faixa.

Lock por página: continue sem lock, como na implementação anterior.

## Coordenadas dos elementos

Elementos de uma página usam espaço LOCAL da página:

```ts
element.pageId
element.x  // 0..pageWidth
element.y  // 0..pageHeight
```

Se hoje x/y são mundiais, converta na migração:

```ts
element.x = element.worldX - page.worldX
element.y = element.worldY - page.worldY
```

Hit-test, drag, resize, texto e formas DEVEM usar o transform da página (zoom + posição da artboard).
Não calcule hit-test no mundo infinito.

Página oculta: some do fluxo do documento (não ocupa Y) OU permanece no fluxo mas com overlay “oculta”, como o Canva. Escolha uma e aplique nos 3 lugares (canvas, rail, faixa). Prefira permanecer no fluxo com estado visual desabilitado, para o índice `1 / N` não pular de forma estranha — a menos que o modelo atual já remova do fluxo; aí seja consistente.

## Arquivos que você pode alterar

- `src/editor.ts` — input da viewport, layout da coluna, scrollToPage, pageIndexAt, ações já extraídas
- `src/styles.css` — `.canvas-viewport`, `.page-stack`, overflow, z-index da barra
- `index.html` — só se o markup do canvas/barra exigir

Não crie arquivo novo de “PagesScrollingPanel” no rail.
Não refatore o app inteiro.
Não mexa em exportar, Formas, texto, imagens, a não ser o necessário para o hit-test no novo transform.

## Passos de implementação (nessa ordem)

1. Identifique no `editor.ts` o handler de wheel, o objeto camera/viewport e o render das páginas. Cite os nomes reais no comentário do commit/resumo.
2. Introduza `scrollY`, `panX`, `zoom` com a semântica de documento. Mapeie a câmera antiga para esses campos se existirem.
3. Force o layout das páginas em coluna (`documentY(i)`). Ignore qualquer x/y mundial antigo das páginas.
4. Troque o wheel padrão para scroll. Zoom só com ctrl/cmd ou pinch ou botões.
5. Implemente clamp. Teste zoom 15%: a coluna permanece no centro.
6. `scrollToPage(id)` usado pelo rail, faixa, grade e setas do cabeçalho.
7. `activePageId` derivado do scroll; barra `i / N` acompanha.
8. Se o painel “Lista” no `#panel` existir, renomeie mentalmente e no UI para “Páginas” (índice). Tire qualquer label “scrolling view” desse painel. O botão da barra inferior que dizia “lista = abrir #panel” deve parar de abrir o rail.
9. Grade e faixa continuam como estão, só sincronizadas com scrollToPage / pageIndexAt.
10. Rode o app e cumpra a lista de aceite. Se algum item falhar, não declare pronto.

## Testes de aceite (todos obrigatórios)

Visual / input (o vídeo atual DEVE deixar de ser reproduzível):

- [ ] Wheel sem ctrl na área cinza ou sobre a página: a Página 2 sobe e ocupa o lugar da Página 1. O zoom % NÃO muda.
- [ ] Ctrl/cmd + wheel: o % da barra muda. As páginas não saem da coluna.
- [ ] Zoom out até ~15%: as duas páginas continuam uma em cima da outra no centro. Não existem dois selos perdidos no cinza.
- [ ] Zoom in até ~180%: consigo ver o detalhe da Página 1; wheel sem ctrl ainda rola em direção à Página 2.
- [ ] Ajustar: a página ativa cabe na viewport.
- [ ] Space+drag ou mãozinha: move um pouco, mas não consigo fugir da coluna.
- [ ] “+ Adicionar página” no fluxo cria Página 3 abaixo e o documento cresce (scroll aumenta).
- [ ] Setas do cabeçalho reordenam e a coluna redesenha sem gaps quebrados.

Índices:

- [ ] Clique numa miniatura da faixa: o canvas rola até essa página.
- [ ] Se houver lista no rail, o clique também rola o canvas — não “abre outro editor”.
- [ ] Grade: clicar uma célula fecha (ou foca) e o documento fica nessa página.
- [ ] Escape fecha a grade. A barra inferior continua clicável por cima da grade (z-index).

Regressão:

- [ ] Aba Formas do rail abre o painel de formas no `#panel`. Não mistura com páginas.
- [ ] Selecionar / arrastar um elemento DENTRO da artboard ainda funciona no zoom atual.
- [ ] Ocultar / duplicar / excluir / adicionar usam as funções já extraídas em `src/editor.ts`.
- [ ] Sem erros de console no fluxo acima.

Critério de falha automática (se acontecer, a tarefa está errada):

- Qualquer frase do tipo “scrolling view reaproveita o slot #panel”.
- Wheel sem modifier alterando o zoom.
- Zoom out mostrando páginas como nodes soltos no infinito.
- Lista de páginas renderizando o documento fora da área central.

## Resumo que você deve devolver no final

Escreva em português:

1. Quais funções/handlers de câmera você alterou (nomes reais).
2. Se a câmera livre foi removida ou só clampada.
3. Como o wheel ficou.
4. O que aconteceu com o painel do `#panel` (índice vs modo).
5. Como rodar e o que você testou.

Não diga que implementou “3 modos estilo Canva” de novo.
Diga: o canvas agora É o scrolling view; faixa e grade são índices/overlays.
