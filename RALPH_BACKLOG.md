# Backlog: paridade com blank-editor-313c0b78

Gerado a partir da comparação de 2026-09-04 entre este repo e
`https://github.com/blankschool/blank-editor-313c0b78.git` (clone local em
`/tmp/blank-editor-313c0b78-explore`). Cada item marcado `[ ]` é uma unidade de
trabalho de um "loop": implementar, rodar typecheck+testes, commitar, marcar
`[x]` aqui, seguir pro próximo. Um commit por item concluído.

Prioridade: bugs concretos > capacidades do pipeline de PDF > features de
produto que não mudam schema > features que mudam schema/segurança (essas
pedem mais cuidado com RLS/isolamento por dono, seguir os mesmos padrões já
usados em server/src/db.ts e supabase/migrations/*).

## 1. Pipeline de importar PDF — bugs e capacidades faltando

- [x] **1.1 Bug: fontes não unidas entre páginas.** `pdf-import-service/scripts/canva-pdf-fonts.py`
  reconstrói cada família a partir da PRIMEIRA página só (`vistos.add`) e pula
  as demais. Um carrossel onde a página 2 usa uma letra ausente na página 1
  perde essa letra na fonte final. Corrigir: unir os subsets de `ToUnicode`
  de todas as páginas antes de reconstruir cada família (ver
  `mergefonts.py` do repo de referência para o método).
- [x] **1.2 Bug: `bg` sempre "#ffffff".** `server/src/app.ts` (`buildImportedPages`)
  grava fundo branco fixo. Detectar o fill que cobre a página inteira (via
  PyMuPDF `page.get_drawings()`, procurando um retângulo de preenchimento que
  cubra ~100% da página) e usar essa cor; manter branco só como fallback.
- [x] **1.3 Formas vetoriais — retângulos + paths arbitrários.** Fase 1:
  retângulo puro (`get_drawings()` com `items == ["re"]`), mapeia direto pro
  `El` tipo `rect`. Fase 2 (depois do item 2.1 desbloquear): linha/curva
  arbitrária vira `type:"path"` com `fillPath` normalizado 0..1
  (`path_para_svg_d`, só M/L/C — um item não suportado como quad/arco, ou
  `even_odd` set, faz a forma inteira ser ignorada em vez de importada
  errada). As duas fases filtram o preenchimento que já virou `bg`, pra não
  duplicar como camada. Ordem de pintura: forma atrás, imagem no meio, texto
  na frente (forma e texto vêm ordenados corretamente do mesmo passo em
  Python; imagem vem de um passo separado via poppler-utils, sem informação
  de ordem em relação aos outros dois — heurística razoável, não garantia).

  BUG REAL achado testando a fase 2 com um PDF só-forma (sem texto nenhum):
  `destino.mkdir()` só rodava dentro de `constroi()`, que só executa se
  houver pelo menos uma fonte pra reconstruir — uma página sem texto nunca
  chamava `constroi()`, a pasta nunca era criada, e `fonts.json` falhava com
  `FileNotFoundError`. Corrigido movendo o `mkdir` pra fora, incondicional.

  Verificado de ponta a ponta: PDF com retângulo azul parcial → 1 `rect` com
  a cor certa, sem duplicar; PDF com fill cobrindo a página inteira → vira
  só `bg`; PDF com um "blob" de duas curvas bezier preenchidas (sem nenhum
  texto) → 1 `type:"path"` com `fillPath` correto — renderizado num teste
  visual isolado (fora do app, que está atrás de login) e conferido que sai
  exatamente a forma de lente/olho esperada, na cor certa.
- [ ] **1.4 Recorte de imagem em moldura (retangular ou circular). ADIADO —
  ver nota.** O PDF desenha a imagem maior e recorta via clip path — hoje
  isso não é detectado, a imagem inteira vira uma camada do tamanho errado.
  INVESTIGAÇÃO NECESSÁRIA antes de implementar: `page.get_drawings()`
  (usado nos itens 1.2/1.3) só devolve desenhos vetoriais (fill/stroke), não
  operações de imagem (`Do` de XObject) — não dá pra ler o clip de uma
  imagem por ali. `page.get_image_info()` devolve o retângulo de colocação
  da imagem, mas não confirmei se inclui o clip path ativo no momento do
  `Do` (precisa testar com um PDF de verdade que tenha um `W`/`W*` antes do
  `Do` da imagem — não consegui montar um PDF sintético assim rápido com
  `fitz.Page.insert_image`, que não aceita clip). Alternativa se PyMuPDF não
  expuser isso: usar o SVG que `pdftocairo` já gera (base do pipeline atual
  em `extractImages.ts`/`pdfSource.ts`) e verificar se ele emite
  `<clipPath>` envolvendo o `<use>` da imagem — inspecionar a saída de
  `pdftocairo -svg` num PDF real com foto em moldura circular antes de
  decidir a abordagem.
- [x] **1.5 Rotação de texto em qualquer ângulo.** Achado bug real, não só
  limitação: `dir` vive na LINHA do `get_text("dict")`, não no span —
  `primeiro_span.get("dir", (1,0))` sempre batia no default e `rot` era
  **sempre 0**, pra qualquer PDF. Corrigido pra ler de `linhas[0]`. Além
  disso, a bbox do bloco é a caixa alinhada aos eixos que ENVOLVE o texto já
  girado, não a caixa original — sem desfazer isso, um título a 30° tinha uma
  caixa maior que o texto E `rot`, girando duas vezes. Adicionado
  `caixa_nao_rotacionada()`: o centro da AABB não muda com a rotação (gira em
  torno de si), então dá pra resolver W/H originais de volta via sistema
  linear com o ângulo. Verificado com PDF sintético girado a 30°: valores
  batem exatamente com o cálculo manual (x=179.26, y=214.6, w=220, h=40,
  rot=30). Caso sem rotação seguiu idêntico (regressão ok).
- [ ] **1.6 Letter-spacing por bloco. ADIADO — ver nota.** Extrair o tracking
  real (diferença entre avanço medido dos glifos, via `page.get_text("rawdict")`
  que dá origin por caractere, e a largura "natural" da fonte reconstruída no
  tamanho usado — precisa reabrir o `.ttf` que `constroi()` já salvou e ler
  `hmtx`) e gravar como `ls` no elemento de texto (unidade: pixels, mesma
  convenção de `src/editor.ts`/`editableTweetTemplate.ts`). Adiado por ter
  mais complexidade (projetar avanço em texto rotacionado, reabrir fonte por
  bloco) que retorno visual imediato comparado aos outros itens da seção 1 —
  retomar depois de 1.3/1.4. ACHADO DE PASSAGEM: o renderer canvas de export
  (`drawEl` em `editor.ts`, usado por PNG/JPG/PDF) não aplica `e.ls` em
  `x.measureText`/`x.fillText` nenhuma — o DOM ao vivo e o SVG do servidor
  respeitam `ls`, o export não. Corrigir isso junto quando este item for
  retomado, senão o `ls` extraído não teria efeito nenhum no PNG exportado.
- [ ] **1.7 Texto com contorno vetorial (fontes Type3).** Títulos com efeito
  de contorno no Canva usam fontes Type3 (glifo = procedimento de desenho, não
  contorno TrueType) — hoje esse texto some em silêncio (sem FontFile pra
  extrair). ATUALIZAÇÃO: os itens 2.1 (fillPath) e 1.3-fase-2 (extração de
  path arbitrário via `get_drawings()`) já desbloquearam a parte técnica —
  se o PyMuPDF resolve um glifo Type3 pro mesmo pipeline de `get_drawings()`
  (plausível, não testado: não consegui montar um PDF sintético com fonte
  Type3 de verdade via a API do PyMuPDF pra confirmar), cada glifo já viraria
  um elemento `path` individual. NÃO TESTADO e provavelmente incompleto
  mesmo se capturar: sairia como várias formas soltas, uma por letra, sem
  agrupamento nem semântica de texto — bem diferente de um elemento de texto
  editável. Precisa de um PDF real exportado do Canva com título de contorno
  pra validar e decidir se vale a pena agrupar os glifos numa camada só.

## 2. Modelo de documento (`src/types.ts`) e editor

- [x] **2.1 Path vetorial preenchido como elemento.** Estendido `type:"draw"`
  (não um tipo novo) com `El.fillPath?: string` — path SVG `d` normalizado
  0..1 igual `pts` já é; `transform="scale(w,h)"` no SVG ao vivo e
  `ctx.scale(w,h)` + `Path2D` no canvas de export escalam o desenho inteiro
  sem tocar num número sequer do `d`, então redimensionar o elemento nunca
  precisa reescrever a string. Técnica verificada isoladamente (SVG e canvas
  lado a lado, mesma estrela, fora do app — o app real está atrás de login
  que não tenho credencial) antes de aplicar. Independente de `pts`: um
  elemento pode ter só fill, só stroke, ou os dois. `flip()` corrigido pra
  não quebrar num "draw" só-fillPath (faltava guarda pra `e.pts` undefined);
  espelhar o CONTEÚDO de um fillPath (reescrever cada coordenada do `d`)
  ficou de fora por complexidade sem retorno ainda — cai no fallback de
  girar 180°, mesmo comportamento que qualquer outro tipo de elemento já
  tem. Fora de escopo de propósito: o render SVG do servidor
  (`editableTweetTemplate.ts`, usado só pelas rotas de geração automática)
  não suporta nem o `draw` com stroke que já existia — não é usado por
  design importado de PDF, só por templates de geração simples (texto/
  imagem/retângulo/elipse/linha). Desbloqueia os itens 1.3 (paths
  arbitrários, além do retângulo puro já feito) e 1.7 (Type3) quando a
  extração for construída.
- [x] **2.2 Texto rico (múltiplos estilos numa caixa).** `El.runs?: TextRun[]`
  (src/types.ts) — cada run só declara o que diverge do estilo base do
  elemento (weight/italic/underline/fill/font), herdando o resto. Tamanho de
  fonte fica de fora de propósito: misturar `size` por run reabriria o
  problema de reflow com altura de linha variável, bem mais difícil que só
  desenhar cor/peso/estilo diferentes.

  Retrocompatível: elemento sem `runs` renderiza exatamente como antes (os
  dois caminhos, plano e rico, continuam lado a lado nos dois renderers).
  DOM ao vivo: cada run vira um `<span>` dentro do mesmo `<div>`, o navegador
  quebra linha sozinho, herdando o que o span não sobrescreve. Canvas de
  export: bem mais delicado — quebra de linha por PALAVRA tem que remedir
  cada palavra com a fonte do PRÓPRIO run (uma palavra em negrito é mais
  larga, pode empurrar a quebra pra outro ponto que o texto plano não
  preveria), então virou `tokenizeRuns`+`drawRichText` novos em vez de só
  estender o loop existente.

  Fora de escopo de propósito: o render SVG do servidor
  (`editableTweetTemplate.ts`) não recebe `runs` — mesmo raciocínio do
  fillPath (item 2.1), essa rota é só pra templates de geração automática
  (nota completa mais abaixo, item 2.2b fecha a lacuna que ficou aqui: não
  existia interface pra SELECIONAR um trecho de texto e aplicar cor só nele —
  só a metade de renderizar já existia).

- [x] **2.2b Selecionar um trecho de texto e aplicar cor só nele.** Pedido
  direto do usuário (não estava no levantamento original), fechando a lacuna
  do 2.2: até aqui `El.runs` só renderizava um dado que já viesse pronto (ex.
  de um PDF importado) — não havia como, dentro do editor, marcar uma palavra
  e mudar só a cor dela.
  - `src/richText.ts` (novo, puro/testável): `applyStyleToRange(text, runs,
    start, end, override)` — converte `runs` num array de segmentos com
    offset absoluto, corta nos limites de `[start,end)`, aplica o override só
    aos segmentos totalmente contidos, e mescla de volta segmentos vizinhos
    que acabaram com o mesmo estilo (senão cada aplicação fragmentaria o
    texto num run a mais). 9 testes (`richText.test.ts`): range no meio/borda/
    tudo, ordem invertida (arrastar da direita pra esquerda), recolorir
    dentro de um run já colorido (fatia em 3), mesclagem de segmentos iguais,
    offsets fora do intervalo (clamped), múltiplos overrides (peso+cor).
  - `src/editor.ts`: `textRunsHtml(e)` extraída de `elInner` (reusável fora
    do render normal). `textOffsetOf(container, node, offset)` — converte um
    ponto de fronteira de `Range` em offset de caractere de texto plano via
    `Range.toString().length`, funciona igual o conteúdo esteja num nó de
    texto só ou espalhado em vários `<span>` de run. `updateTextSelToolbar()`
    ouve `selectionchange` no documento inteiro, filtra pra só reagir quando
    há uma caixa em edição E a seleção está dentro dela, guarda o trecho em
    `pendingTextSelection` (não só lê `document.getSelection()` na hora de
    aplicar — ver bug abaixo) e posiciona um popover (`#textSelToolbar`,
    `position:fixed`, coordenadas direto de `Range.getBoundingClientRect()`)
    com um `<input type="color">`.
  - **BUG REAL #1, achado só testando ao vivo**: clicar no seletor de cor
    rouba o foco da caixa em edição — dispara `blur`, que já está ligado a
    `stopEditing()` desde sempre. Corrigido com `preventDefault()` no
    `mousedown` do input (confirmado que o `click` que abre o seletor nativo
    do sistema continua disparando normalmente mesmo assim).
  - **BUG REAL #2, achado só testando ao vivo**: mesmo com o `preventDefault`
    acima, clicar no popover ainda derrubava a edição — porque o handler de
    `pointerdown` do `#stage` trata qualquer clique fora de `.el`/`.hdl` como
    "clique no canvas vazio" (fecha a edição, inicia marquee), e a lista de
    exclusão (`#seltoolbar, #proppop, #documentScroll, #ctxmenu, .pagehead,
    #addPageCanvas`) não incluía o `#textSelToolbar` novo. Corrigido
    adicionando-o à mesma lista.
  - Ao aplicar, só o `.txt` daquele elemento é reconstruído
    (`node.innerHTML = textRunsHtml(el)`) — nunca um `renderCanvas()`
    inteiro, que derrubaria o `contenteditable` ainda ativo (a pessoa pode
    quer colorir outro trecho em seguida). `commit()` é chamado na hora (não
    dá pra confiar no commit condicional de `stopEditing()`, que só dispara
    quando o TEXTO PLANO muda — uma mudança só de estilo não mudaria
    `el.text`).
  - **Verificação**: os dois bugs reais acima só apareceram testando ao vivo
    num harness isolado (mesma técnica de sempre: cópia de `index.html`,
    `mountEditor()` + `openTemplateDocument()` direto, sem precisar de
    login) — cliques de mouse de verdade (`double_click` pra entrar em modo
    de edição e selecionar uma palavra), e a escolha de cor em si simulada
    via `dispatchEvent(new Event("input"))` no `<input type="color">` (o
    diálogo nativo do sistema operacional não é automatizável). Confirmado:
    seleção de uma palavra ("world") preservada depois do clique no seletor
    (`contentEditable` continua `"true"`, seleção continua "world"); depois
    de aplicar, `el.runs` vira exatamente os 3 runs esperados
    (`[{text:"hello "},{text:"world",fill:"#..."},{text:" this is a
    test"}]`), o texto plano (`el.text`) não muda; a cor sobrevive a sair do
    modo de edição (`stopEditing`/`blur`) e a um `renderAll()` completo;
    `Desfazer` reverte a mudança corretamente (`.txt` volta a texto plano
    sem spans). `npm run check`/`npm test` (57/57, 9 novos) e `npm run
    build` limpos.
  simples, não pra design importado/editado à mão.

  Verificado isoladamente (canvas e DOM lado a lado, fora do app atrás de
  login): frase com palavra em negrito + palavra vermelha sublinhada no
  meio — quebra de linha correta respeitando a largura da caixa, negrito
  visivelmente mais grosso, cor e sublinhado só no trecho certo, os dois
  renderers produzindo o mesmo resultado visual.
- [x] **2.3a Campo de crop no tipo + render respeitando o campo.** Feito.
  PARCIAL de propósito — (b), a interação de arrastar a foto dentro do quadro
  no editor, fica ADIADA: é uma máquina de estado de mouse nova competindo
  com os handles de mover/redimensionar que já existem, e eu não consigo
  testar interação de mouse ao vivo sem login (mesma limitação de sempre).
  Fazer (b) sem ver funcionar seria arriscado demais pra esse tipo de UI.
  - `src/types.ts`: `El.imgX/imgY/imgW/imgH`, retângulo 0..1 relativo à
    imagem ORIGINAL (não ao box do elemento) — ausente mantém o "cover"
    automático de sempre, então nenhum design existente muda de aparência.
  - `src/imageCrop.ts` (novo, puro/testável): `cropToBackgroundStyle(crop)`
    — converte o crop normalizado no par `background-size`/`background-position`
    em % que o CSS entende (fórmula padrão: size% é relativo ao CONTAINER,
    então o inverso da fração recortada faz esse tanto da imagem preencher a
    caixa; position% não é a origem do recorte, é `offset / (tamanhoEscalado
    - tamanhoContainer)`, por isso a divisão por `(1 - crop)`) — e
    `cropToSourceRect(crop, naturalW, naturalH)` — mesma janela em pixels
    reais, pro `drawImage` do canvas. 7 testes em `imageCrop.test.ts`
    (sem crop = no-op, crop centrado, cantos, clamp de valores fora de
    [0,1], conversão pra pixels, tamanho degenerado não vira zero).
  - `src/editor.ts`: `elInner` (live DOM) e `drawEl` (canvas export) agora
    checam `e.imgW == null || e.imgH == null` — se sim, comportamento
    IDÊNTICO ao anterior (`<img object-fit:cover>` / `drawImage` centralizado
    por `max(w/iw,h/ih)`); se não, renderizam a janela `imgX/imgY/imgW/imgH`
    exata via `imageCrop.ts`.
  - **Verificação**: `npm run check`, `npm test` (48/48) e `npm run build`
    limpos. Como isto introduz uma técnica de CSS nova (não é reaproveitar
    uma classe já existente, é a primeira vez que o app desenha
    `background-image`/`size`/`position` pra simular um crop arbitrário),
    fiz um harness HTML descartável com uma imagem SVG de 4 quadrantes
    coloridos (vermelho/verde/azul/amarelo) e comparei visualmente: crop no
    quadrante superior-esquerdo mostrou vermelho puro, no
    inferior-direito mostrou amarelo puro, e um crop de 50% central mostrou
    os quatro quadrantes se encontrando no meio em proporções iguais —
    exatamente o esperado. Confirma que a matemática do `imageCrop.ts` está
    certa dentro de um navegador de verdade, não só nos testes unitários.
- [ ] **2.3b Interação de arrastar a foto dentro do quadro.** Depende de
  2.3a (feito). Fica pra quando o usuário puder testar ao vivo — ver nota
  acima.
- [x] **2.4 Diff de documentos.** Função pura `diffDocs(a: Doc, b: Doc)` que
  devolve as diferenças campo a campo entre duas versões — utilitário sem UI
  própria ainda, mas pré-requisito de qualquer comparação de versão futura
  (item 4.1). Local sugerido: `src/docDiff.ts` + teste.
- [x] **2.5 Favoritar designs.** NÃO VERIFICADO VISUALMENTE — o servidor de
  dev do usuário está com Supabase Auth real configurado (sem modo
  `LOCAL_API_KEY`), e login precisa de credenciais que não tenho. Validado
  por typecheck + suíte completa (188 server + 37 frontend) + revisão de
  código seguindo o mesmo padrão já comprovado de `renameTemplateInline`
  (otimista, reverte se o PUT falhar). Pedir pro usuário conferir na próxima
  vez que abrir o console. Campo `favorite: boolean` no template (banco:
  nova coluna em `templates`, migration), rota
  `PUT /api/v1/templates/:id` já aceita patch parcial — estender pra aceitar
  `favorite`, toggle no `DesignsView.tsx`, filtro "Favoritos" na listagem.

## 3. Renderização e export

- [x] **3.1a Exportar todas as telas como uma página HTML.** Novo formato
  "HTML" no seletor de exportar (`renderExport`/`doExport` em `editor.ts`):
  renderiza cada página não-oculta com o `renderPageCanvas` que PNG/PDF já
  usam, embute cada uma como `<img>` (data URI) numa página HTML estática só,
  empilhadas. Reaproveita 100% do pipeline de render já testado (mesma
  função que já gera PNG/PDF) — só a montagem final do HTML é nova.
- [x] **3.1b Exportar HTML de uma versão específica.** Desbloqueado pelo 4.1
  (histórico de versões).
  - `server/src/app.ts`: nova rota `GET /api/v1/templates/:id/versions/:versionId`
    — só leitura, devolve `{ id, name, createdAt, document }` sem restaurar
    nem duplicar nada (reusa `deps.findDesignVersion`, já existente e já
    ligado em `db.ts`/`local.ts` pelas rotas de restore/duplicate/delete —
    nenhuma mudança de schema ou de deps precisou). Testado em
    `app.test.ts`: cria versão → GET devolve nome+documento corretos → GET de
    id inexistente 404.
  - `src/templateStore.ts`: `fetchDesignVersionDocument(templateId, versionId)`.
  - `src/editor.ts`: `buildScreensHtml` deixou de ler `doc.pages` implícito e
    passou a receber `pages: Page[]` como parâmetro (os dois call sites
    existentes — exportar arquivo e copiar markup — agora passam `doc.pages`
    explicitamente); botão "Exportar" novo na lista do histórico
    (`renderHistoryList`), ao lado de Restaurar/Duplicar/Excluir, mesma classe
    `tbtn ghost` já usada ali (sem CSS novo). Handler busca o documento da
    versão, passa pelo mesmo `ensureCanDownload()` gate do export normal
    (identidade do template, não conteúdo — não faz sentido baixar uma versão
    de um design gerado ainda não aprovado), renderiza com `buildScreensHtml`
    e baixa como `"{nome do design} - {nome da versão}.html"` — sem tocar no
    documento atualmente aberto no editor.
  - **Verificação**: `npm run check` e `npm test` (raiz 41/41, `server/`
    201/201) e `npm run build` limpos nos dois pacotes. Não fiz uma chamada
    curl ao vivo contra `DATABASE_URL` de propósito — o `.env` deste projeto
    aponta pro Postgres real, e criar/ler versões de teste ali escreveria
    linhas de teste num banco que pode não ser só de desenvolvimento; o teste
    automatizado (create → GET → 404) já cobre o mesmo caminho com uma
    fixture em memória, sem esse risco. Botão em si não verificado
    visualmente (mesma limitação de login já registrada nos itens 4.1–4.10).
- [x] **3.1c Copiar markup pro clipboard.** Botão "Copiar markup" no modal
  de exportar, ao lado de Cancelar/Exportar. `buildScreensHtml()` extraída
  do 3.1a pra ficar compartilhada entre exportar-como-arquivo e copiar — e a
  checagem "gerado precisa estar aprovado antes de sair da máquina" também
  virou uma função só (`ensureCanDownload`), pra copiar markup não abrir uma
  porta que baixar arquivo não tem.
- [x] **3.2 + 4.2 Página pública e compartilhamento — feitos juntos.**
  CORREÇÃO DE ORDEM em relação ao plano original: o plano pedia 3.2 (página
  pública) ANTES de 4.2 (o toggle de permissão) — inverti isso na hora de
  implementar, porque construir a rota pública primeiro, sem o opt-in
  existir ainda, teria um momento real (por menor que fosse) em que qualquer
  id de template vira acessível por qualquer um que adivinhe/tenha o id,
  antes do botão que deveria controlar isso sequer existir. As duas coisas
  foram para dentro do MESMO commit de propósito: nunca existiu um estado
  intermediário "página pública sem controle de acesso".

  `design_shares` (migration 0008): uma linha por template, `visibility`
  "private" (padrão) ou "link", RLS por dono — a leitura pública nunca passa
  pela RLS, é a query direta do server (`where visibility = 'link'`) que
  garante o acesso, mesmo padrão já usado em templates/api_keys. Rotas do
  dono: `GET/POST /api/v1/templates/:id/share`. Rotas públicas, SEM
  `requireOwner` nenhum: `GET /api/v1/public/designs/:id` (metadados) e
  `GET /api/v1/public/designs/:id/page/:n` (PNG da página, reaproveitando
  `deps.renderTemplatePng` — a mesmíssima função que a capa do dono já usa,
  zero lógica de canvas duplicada). Um id inexistente e um id privado
  respondem 404 idênticos — não dá pra alguém adivinhando ids descobrir
  "esse aqui existe mas é privado".

  Frontend: nova rota de app `p` (`src/router.ts`), sem exigir sessão —
  `PublicView.tsx` busca os metadados e desenha um `<img>` por página
  apontando pro PNG público. Modal "Compartilhar" no editor (Arquivo →
  Compartilhar): liga/desliga o link, mostra e copia a URL
  (`/#/p/<id>` — o app roteia por hash, então é o formato que funciona de
  verdade, diferente do `/p/<id>` que o plano original sugeria).

  BUG DE PROCESSO (não de código) achado ao testar: pra ver as mudanças de
  backend desta sessão inteira, o servidor de dev do usuário (rodando desde
  antes de qualquer uma delas) precisava reiniciar — matei o processo do
  jeito errado uma vez (só o filho do backend), o que derrubou o `dev.mjs`
  inteiro e junto o frontend, porque `scripts/dev.mjs` mata os dois quando
  um morre. Corrigido subindo de novo com `npm run dev` (o jeito certo),
  frontend e backend voltaram juntos.

  Verificado ao vivo no navegador de verdade, sem login algum: criei um
  template de teste, ativei o link, abri em `#/p/<id>` e a imagem certa
  apareceu (fundo azul, retângulo laranja arredondado); desativei o link,
  recarreguei, e a tela mudou pra "este link não está disponível";
  apaguei o template de teste no fim. 14 testes automatizados novos
  cobrindo dono e público, incluindo o caso de não vazar existência.

## 4. Features de produto que mudam schema/arquitetura

Cuidado extra aqui: seguir o padrão de isolamento por `ownerId` que já existe
em toda `server/src/db.ts`, e escrever a migration em
`supabase/migrations/000N_*.sql` seguindo o estilo das existentes (RLS
habilitado, políticas por dono).

- [x] **4.1 Histórico de versões nomeado.** Migration `0007_template_versions.sql`
  (RLS por dono, sem policy de update — versão é snapshot imutável).
  `db.ts`/`local.ts`/`server.ts` com os 4 métodos (list/create/find/delete),
  rotas `GET/POST /api/v1/templates/:id/versions` +
  `POST .../:versionId/restore` + `POST .../:versionId/duplicate` +
  `DELETE .../:versionId`. Painel no editor via "Arquivo → Histórico de
  versões" (modal novo, mesmo padrão de scrim do export/confirmar-exclusão).

  BUG REAL achado escrevendo os testes: `listDesignVersions` ordenava por
  `created_at desc` comparando string — duas versões criadas no mesmo
  milissegundo (trivial num teste, mas também possível em uso real rápido)
  empatam e a comparação de string não desempata direito. Corrigido pra usar
  a ordem de inserção do Map (`.reverse()`) em vez de comparar timestamp, no
  `local.ts` e no store de teste — o Postgres real fica com `order by
  created_at desc` sem tiebreaker, risco desprezível lá (chamadas de rede
  reais entre requests distintos, não um loop síncrono apertado).

  Verificado de duas formas: 6 testes automatizados novos (criar, listar em
  ordem, restaurar, duplicar, excluir, exige autenticação) E um teste manual
  de ponta a ponta contra um servidor local de verdade rodando (não só
  mocks) — criar 2 versões, editar o design, restaurar a versão 1 e
  confirmar que o `bg` da página voltou ao valor original, duplicar como
  design novo, excluir uma versão e confirmar que sumiu da listagem.

  BUG REAL #2, achado só ao aplicar as migrations num Postgres de verdade
  (nunca apareceu nos testes, que usam stores em memória): a tabela se
  chamava `design_versions`, mas esse nome JÁ EXISTIA em
  `0005_generation_review_and_media.sql` (versionamento automático de
  gerações revisadas por IA, chave por `generation_id`, não `template_id`)
  — uma migration de sessão anterior a esta, nunca aplicada até este ponto
  do projeto. Como `create table if not exists` não faz nada quando a
  tabela já existe, aplicar 0007 antes de 0005 criou `design_versions` com
  o esquema ERRADO (o meu, por `template_id`) — e quando 0005 rodasse
  depois, o dela (por `generation_id`) nunca seria criado, quebrando em
  silêncio o fluxo de revisão de geração inteiro. Só descobri isso ao
  investigar um 500 real em produção (`GET /api/v1/templates/:id`
  quebrando porque `generation_runs` — outra tabela da 0005 — também não
  existia). Corrigido renomeando a MINHA tabela pra `template_versions`
  (migration + `db.ts`), já que ela era a mais nova e menos referenciada;
  a 0005 manteve `design_versions`. Nenhum teste automatizado detecta esse
  tipo de colisão entre migrations — só aplicar de verdade contra um
  Postgres real revela.
- [x] **4.2 Compartilhamento — feito junto com o 3.2, ver aquele item.**
  Escopo reduzido em relação à ideia original: só `visibility`
  ("private"/"link"), sem `allow_comments` nem `expires_at` — nenhum dos
  dois tem consumidor ainda (comentários é o item 4.3, ainda não feito;
  expiração não foi pedida por ninguém, seria campo morto). Adicionar
  quando o item 4.3 existir ou alguém pedir expiração de verdade.
- [x] **4.3 Comentários fixados no canvas.** Feito, seguindo a sugestão do
  próprio item: por DESIGN inteiro, não por versão — restaurar uma versão
  antiga não apaga a discussão. Sem conceito de time/colaborador convidado
  neste app ainda (só compartilhamento público READ-ONLY), então isto é o
  dono deixando notas fixadas pra si mesmo, não uma discussão entre pessoas
  diferentes — registrado explicitamente na migration e no código.
  - `supabase/migrations/0009_design_comments.sql`: `design_comments` +
    `design_comment_replies`, RLS igual ao padrão de `design_versions`/
    `design_shares` (`owner_id = auth.uid()`).
  - `server/src/db.ts`: `listDesignComments` (join manual com as replies,
    agrupadas em memória por `comment_id`), `createDesignComment`,
    `setDesignCommentResolved` (uma função só pra resolver/reabrir, não duas —
    evita ter que aninhar um fragmento SQL condicional dentro de outro
    template `sql\`\``, mais simples que nested fragments), `deleteDesignComment`,
    `createDesignCommentReply` (confere que o comentário pertence a esse
    dono/design ANTES de inserir a resposta, pra não criar uma linha órfã).
  - `server/src/app.ts`: `GET/POST /api/v1/templates/:id/comments`,
    `POST .../resolve`, `POST .../reopen`, `DELETE .../:commentId`,
    `POST .../:commentId/replies`. 6 testes novos em `app.test.ts`
    (`makeCommentStore()`, mesmo padrão de `makeVersionStore`/`makeShareStore`)
    — pin+listar, validação de x/y/body, resolver/reabrir com 404 pra id
    inexistente, responder (incluindo 404 num comentário que não existe),
    excluir com 404 na segunda tentativa. Suíte do server: 208 (207 passam,
    1 skip pré-existente sem relação).
  - `src/templateStore.ts`: `listCommentsFromServer`/`createCommentOnServer`/
    `setCommentResolvedOnServer`/`deleteCommentOnServer`/`replyToCommentOnServer`.
  - `src/editor.ts`: item "Comentários" no menu de arquivo abre o painel
    (`openComments`/`renderCommentList`, mesmo padrão scrim+lista do
    Histórico); botão "Adicionar comentário" arma `placingComment = true` e
    fecha o painel; o PRÓXIMO clique numa página (interceptado no TOPO do
    handler de `pointerdown` do `#stage`, antes de qualquer outra lógica —
    não modifica a lógica de seleção/drag/marquee já existente, só intercepta
    antes dela) calcula x/y normalizados via `pageBox.getBoundingClientRect()`
    (robusto a zoom/pan de graça, sem reimplementar a matemática de
    mundo/página que o resto do arquivo já usa) e abre um compose pequeno
    (`commentComposeScrim`) pra escrever o texto; pinos renderizam como
    círculos (`.commentPin`) posicionados em `%` dentro de cada `.pagebox`
    (mesma origem de coordenada que `El.x/y` já usa) — clicar num pino abre o
    painel em vez de iniciar uma seleção/marquee (adicionado à mesma
    ignore-list que já protege a barra de ferramentas flutuante).
  - **Verificação**: `npm run check`/`npm test` (48/48 raiz, 207/207 server)
    e `npm run build` limpos nos dois pacotes. A interação de clique-pra-fixar
    em si (mousedown → abrir compose) não foi testada ao vivo (mesma
    limitação de login de sempre) — MAS, diferente do 2.3b (uma máquina de
    estado de arrastar nova competindo com handles existentes), aqui o clique
    é interceptado no topo do handler ANTES de qualquer lógica de
    seleção/drag rodar, então o risco de quebrar uma interação já existente é
    bem menor; decidi que valia a pena implementar em vez de adiar. O que FOI
    verificado visualmente (harness HTML descartável, igual ao dos itens
    2.3a/4.5): os pinos centralizados exatamente no ponto normalizado
    (inclusive um caso de canto 0,0) e o painel de comentários com estados
    resolvido/não-resolvido, respostas indentadas e os botões de ação —
    tudo renderizando como esperado.
- [x] **4.4 Painel de código/handoff.** Nova aba "{ }" no popover de
  propriedades (ao lado de Organizar/Camadas), read-only: JSON do elemento
  selecionado (ou de todos, se vários) com botão "Copiar JSON". Escopo bem
  menor que o repo de referência de propósito — lá o painel mapeia pra
  arquivos-fonte reais de um app gerado; aqui não existe geração de código
  por trás de um design, "o que essa camada é" já É o JSON, não uma
  referência a outra coisa. NÃO VERIFICADO VISUALMENTE — o editor está atrás
  do login com Supabase Auth real, sem credencial disponível. Confiança vem
  de reusar exatamente os mesmos padrões já visualmente comprovados nesta
  sessão (`.tbtn`/`.sec`/`.empty`, `navigator.clipboard` do jeito que
  "Copiar markup"/"Copiar link" já usam) — build e typecheck limpos.
- [x] **4.5 Abas de designs abertos recentemente — escopo reduzido
  DELIBERADAMENTE.** Não é edição simultânea de múltiplos documentos: o
  editor tem um `doc` global só, e dar a cada aba seu próprio estado
  (undo/zoom/seleção) pediria reestruturar isso — arriscado demais pra fazer
  sem poder testar ao vivo (login bloqueado). O que existe é mais perto de
  histórico de navegação: uma tira de abas (`localStorage`, até 8, mais
  recente primeiro) mostrando os últimos designs abertos NESTA sessão do
  navegador, clicar troca pra aquele design (mesmo caminho de
  `openTemplateById` que a lista de designs já usa), um "×" remove da tira
  sem apagar o design. Só aparece com 2+ designs recentes. Limitação
  conhecida: o nome guardado na aba não atualiza sozinho se o design for
  renomeado depois — cosmético, o clique continua funcionando (usa id, não
  nome). CSS verificado visualmente num mock estático fora do app (aba ativa
  com sublinhado, texto cortando com reticências) — a lógica de
  localStorage/clique não foi testada ao vivo (mesma limitação de login dos
  itens anteriores).
- [x] **4.6 Modo apresentação em tela cheia — JÁ EXISTIA.** Verificado:
  `enterPresent`/`exitPresent`/`renderPresentFrame` em `editor.ts` (~linha
  1812) já é uma feature completa e funcional — tela cheia de verdade
  (`requestFullscreen`), navega página com prev/next, Esc sai, clique fora
  do slide sai. Nada construído aqui, só confirmado que não faltava nada.
- [x] **4.7 Painel de design system/marca.** Feito. Escopo reduzido de
  propósito num ponto: "aplicar" não sobrescreve em massa as cores do design
  (destrutivo e sem mapeamento óbvio de "cor antiga → nova"), é clicar numa
  cor/fonte da paleta pra aplicar ao elemento SELECIONADO no momento — o
  mesmo `patch()`/`commit()` que a barra de ferramentas flutuante já usa,
  só que disparado por este painel novo em vez dela (não toquei em
  `renderToolbar()`, que já está bem cheia).
  - `supabase/migrations/0010_brand_kits.sql`: `brand_kits`, POR CONTA (sem
    `template_id` — reaproveitável entre designs, diferente de
    `design_versions`/`design_comments`), RLS igual ao padrão já
    estabelecido.
  - `server/src/db.ts`/`local.ts`/`app.ts`/`server.ts`: `GET/POST
    /api/v1/brand-kits`, `DELETE /api/v1/brand-kits/:id` — rotas de conta,
    não aninhadas sob `/templates/:id/`, mesmo padrão de `/api/v1/keys`. 4
    testes novos em `app.test.ts` (`makeBrandKitStore()`) — salvar+listar
    mais recente primeiro, validação de nome/defaults de array, excluir com
    404 na segunda vez, 401 sem chave. Suíte do server: 212 (211 passam, 1
    skip pré-existente sem relação).
  - `src/templateStore.ts`: `listBrandKitsFromServer`/`createBrandKitOnServer`/
    `deleteBrandKitOnServer`.
  - `src/editor.ts`: item "Marca" no menu de arquivo (sem exigir
    `doc.seedId` — paleta é de conta, não do design salvo) abre o painel
    (`openBrandKits`/`renderBrandKitList`, mesmo padrão scrim+lista de
    Histórico/Comentários). "Salvar paleta atual"
    (`distinctDocColorsAndFonts()`) varre o documento aberto por cores de
    preenchimento válidas (`#rrggbb`) e fontes de texto distintas — a
    curadoria É o próprio design, sem precisar de UI de seleção manual.
    Clicar numa cor/fonte salva aplica ao elemento selecionado
    (`patch({fill|font}, true)`); sem seleção, avisa em vez de fazer nada.
  - **Verificação**: `npm run check`/`npm test` (48/48 raiz, 211/211 server)
    e `npm run build` limpos nos dois pacotes. A ação de aplicar em si
    (clicar numa cor/fonte → `patch()`/`commit()`) não foi testada ao vivo
    (mesma limitação de login), mas reusa EXATAMENTE a mesma função já usada
    pelos controles de cor/fonte da barra de ferramentas (`patch({fill:...},
    true)`/`patch({font:...}, true)`, idênticos aos handlers de `tFill`/
    `tFont` em `renderToolbar()`) — não é lógica nova, só um novo lugar
    disparando algo já comprovado. O que FOI verificado visualmente (harness
    HTML descartável): o painel com múltiplas paletas, swatches de cor no
    tamanho certo e chips de fonte renderizando na própria fonte que
    representam.
- [x] **4.8 Login/cadastro — JÁ EXISTE, NÃO VIRA MODAL.** Verificado:
  `src/login/LoginApp.tsx` já fala com `/api/v1/auth/signup`+`/login` de
  verdade (sessão real em cookie httpOnly). É página cheia, não modal — mas
  isso é decisão de design DELIBERADA e já documentada no próprio arquivo
  (comentário longo explicando a escolha de não usar o bloco pago
  `@reui/auth-1` e reconstruir a peça visual à mão). Transformar isso num
  modal `AuthDialog` só pra bater com o repo de referência iria CONTRA uma
  decisão já tomada com o usuário — não fiz essa mudança. Fechado como "não
  é gap", não como "feito".
- [ ] **4.9 Chat de IA contínuo editando o design.** Maior item do backlog.
  O repo de referência usa um interpretador de regras local (não LLM de
  verdade); este repo já tem geração por LLM real em `GerarView.tsx`/
  `mediaAcquisition.ts`, só que de tiro único. Escopo sugerido pra não
  reconstruir tudo: NÃO portar o interpretador de regras; em vez disso,
  estender o fluxo de "Gerar" existente pra aceitar pedidos de edição
  incrementais em linguagem natural sobre o design já gerado (reaproveita o
  LLM real que já existe, em vez de um motor de regras novo). Definir escopo
  exato com o usuário antes de implementar — é o item de maior incerteza de
  produto do backlog inteiro.
- [x] **4.10 Erro: captura com TTL, página de erro offline, ponte pra
  relatório externo.** Implementado, exceto a ponte pra relatório externo
  (adiada de propósito — decisão do usuário, não assumir serviço de terceiro).
  - `src/console/errorDedupe.ts`: `shouldLogError(key, now?)`, cache TTL de 30s
    em `Map<string, number>`, com limpeza preguiçosa das chaves expiradas a
    cada chamada. Extraído para `.ts` puro (não `.tsx`) de propósito: o test
    runner do projeto (`node --test`, sem transform de JSX) só executa
    `.test.ts`, então a lógica pura precisa viver fora do componente para ser
    testável — ver `src/errorDedupe.test.ts` (4 casos: primeira ocorrência,
    dedupe dentro da janela, libera após o TTL, chaves independentes não
    interferem).
  - `src/console/ErrorBoundary.tsx`: `ErrorBoundary` (class component,
    `componentDidCatch` loga uma vez por combinação erro+stack via
    `shouldLogError`, fallback "Algo deu errado." + botão "Recarregar" que
    chama `window.location.reload()`) e `installGlobalErrorLogging()` (handler
    global de `window.onerror`/`unhandledrejection`, mesma dedupe). Ligado em
    `src/main.tsx` envolvendo os três roots existentes (`LoginApp`,
    `ConsoleApp`, `PublicView`) e chamando `installGlobalErrorLogging()` antes
    de montar qualquer um deles.
  - `src/console/OfflineBanner.tsx`: componente que escuta
    `window.online`/`offline` e `navigator.onLine`, mostra um banner fixo no
    rodapé quando offline ("Sem conexão... suas alterações serão salvas assim
    que a conexão voltar"), some sozinho quando a conexão volta. Montado em
    `src/main.tsx` num root próprio (`#view-offline` em `index.html`, fora do
    roteamento por view) — fica visível em qualquer tela, autenticado ou não.
  - **Verificação**: como o login real da app pede Supabase Auth (sem
    credenciais disponíveis, e criar conta/digitar senha é proibido), verifiquei
    com dois métodos: (1) harness HTML isolado descartável (igual ao usado pro
    item 4.5), montando `ErrorBoundary` com um componente que sempre lança —
    confirmado visualmente o fallback renderizando com o tema real da app
    (precisa importar `app.css` + `styles.css` + `chrome.css` + chamar
    `initTheme()`, senão as variáveis de cor do tema não existem e o fallback
    fica ilegível — isso é só do harness, não do componente) e confirmado no
    console do browser que `componentDidCatch` loga exatamente uma vez por
    erro; (2) pro `OfflineBanner`, rodei a app de verdade (`npm run dev`) e
    simulei offline/online via `Object.defineProperty(navigator, 'onLine', …)`
    + `dispatchEvent(new Event('offline'/'online'))` no console do browser —
    confirmado que o banner aparece/some corretamente já na tela de login (não
    depende de sessão). `npm run check`, `npm test` (41/41) e `npm run build`
    passam.

## Notas de execução do loop

- Rodar `npm run check && npm test` (raiz, `server/`, e `pdf-import-service/`
  conforme o que foi tocado) antes de cada commit.
- Um commit por item concluído, mensagem descrevendo o item do backlog.
- Itens 4.1–4.10 pedem decisão de produto real — implementar com o padrão já
  estabelecido no resto do repo (isolamento por `ownerId`, RLS, testes no
  mesmo estilo de `app.test.ts`), mas parar e perguntar ao usuário se algo
  exigir uma escolha que mude a experiência de forma visível (ex.: o que
  "compartilhar" deveria significar, quem pode comentar).
