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
- [x] **1.3 Formas vetoriais — retângulos de cor sólida.** Escopo reduzido
  deliberadamente: só retângulo puro (`get_drawings()` com `items == ["re"]`),
  que mapeia direto pro `El` tipo `rect` que já existe — sem mudança de
  render nenhuma. Path arbitrário com curvas (ícones, halftone, contorno de
  título) fica pendente do item 2.1 (o `draw` do editor só guarda polyline
  com stroke, sem fill arbitrário) — quando esse tipo existir, retomar aqui.
  Filtra o preenchimento que já virou `bg` da página, pra não duplicar como
  camada. Ordem de pintura: forma atrás, imagem no meio, texto na frente
  (forma e texto vêm ordenados corretamente do mesmo passo em Python; imagem
  vem de um passo separado via poppler-utils, sem informação de ordem em
  relação aos outros dois — heurística razoável, não garantia). Verificado
  de ponta a ponta: PDF sintético com retângulo azul parcial (não cobre a
  página) → 1 elemento `rect` com a cor certa (#1a3399), sem duplicar; PDF
  com fill cobrindo a página inteira → vira só `bg`, zero elementos `rect`
  redundantes; via `POST /api/v1/imports/pdf` real, o documento final tem
  forma → imagem → texto na ordem certa, cor e posição batendo.
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
  extrair). CORREÇÃO à nota anterior: o item 1.3 só extrai retângulo puro
  (`items == ["re"]`) de propósito — um glifo Type3 vira um `path` com curvas
  (letras não são retângulos), então 1.3 NÃO cobre este caso ainda. Continua
  bloqueado no item 2.1 (tipo de elemento pra path preenchido arbitrário no
  editor) — sem ele, extrair esses paths não teria onde render dentro do
  documento.

## 2. Modelo de documento (`src/types.ts`) e editor

- [ ] **2.1 Path vetorial preenchido como elemento.** Hoje `type:"draw"` só
  guarda uma polyline com stroke (sem preenchimento arbitrário). Adicionar
  suporte a um `d` de path SVG preenchido (reaproveitando ou estendendo
  `draw`), pra receber o que o item 1.3 extrai e pro editor desenhar formas
  livres preenchidas manualmente.
- [ ] **2.2 Texto rico (múltiplos estilos numa caixa).** `El.text` é uma
  string plana com um único font/size/weight/fill pra caixa inteira. Adicionar
  um campo opcional `runs?: Array<{text, weight?, italic?, fill?}>` que,
  quando presente, o renderer (canvas em `editor.ts` e o server em
  `render/renderTweet.ts`) desenha por trecho em vez do texto inteiro num
  estilo só. Retrocompatível: elemento sem `runs` continua igual a hoje.
- [ ] **2.3 Recorte/reenquadramento de foto independente da moldura.** Guardar
  no `El` de imagem um crop próprio (`imgX/imgY/imgW/imgH` relativos à foto
  original, ou equivalente) em vez de recalcular "cover" a cada render —sem
  isso, mover a foto dentro do quadro não é possível e redimensionar a moldura
  distorce o enquadramento. Precisa de UI no editor pra arrastar a foto dentro
  do quadro (like Canva/Figma) — maior escopo, quebrar em: (a) campo no tipo +
  render respeitando o campo, (b) interação de arrastar no editor.
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

- [ ] **3.1 Exportar HTML de uma versão / todas as telas numa página / copiar
  markup.** Hoje `doExport` em `editor.ts` só faz PNG/JPG/PDF/JSON de UMA
  página. Adicionar modos: HTML de uma versão específica (precisa do item 4.1
  de histórico existir primeiro — depende), "todas as telas numa página HTML"
  (não depende de nada, dá pra fazer já: gerar um HTML com todas as páginas do
  doc atual empilhadas), "copiar markup" (serializa o doc atual pra um HTML
  estático e copia pro clipboard). Fazer só a opção sem dependência primeiro.
- [ ] **3.2 Página pública `/t/:slug`.** Rota nova (server + frontend) que
  serve um HTML somente-leitura de um design por slug, sem precisar do
  console/editor — pré-requisito de compartilhamento (item 4.2). Precisa
  decidir: slug é gerado automaticamente ou escolhido? Sugestão: reaproveitar
  o `id` do template como slug por enquanto (sem UI de slug customizado),
  focar em fazer a rota funcionar.

## 4. Features de produto que mudam schema/arquitetura

Cuidado extra aqui: seguir o padrão de isolamento por `ownerId` que já existe
em toda `server/src/db.ts`, e escrever a migration em
`supabase/migrations/000N_*.sql` seguindo o estilo das existentes (RLS
habilitado, políticas por dono).

- [ ] **4.1 Histórico de versões nomeado.** Tabela nova (`design_versions`:
  id, template_id, owner_id, name, document, created_at), rotas
  `POST/GET/PUT/DELETE /api/v1/templates/:id/versions`, painel no editor
  (criar/restaurar/duplicar/excluir versão nomeada — diferente do
  `generationWorkflow.ts` que já versiona gerações automáticas; isto é
  manual, iniciado pela pessoa).
- [ ] **4.2 Compartilhamento com link e permissões.** Depende do item 3.2.
  Tabela `design_shares` (template_id, visibility: "private"|"link", allow
  comments: bool, expires_at nullable). Rota
  `POST /api/v1/templates/:id/share`, diálogo no editor, a página `/t/:slug`
  (item 3.2) passa a checar essa tabela antes de servir.
- [ ] **4.3 Comentários fixados no canvas.** Tabelas `design_comments` +
  `design_comment_replies` (mesmo padrão de `approvals`/`generation_workflow`
  já existente), pin por `x/y` relativo à página, resolver/reabrir, painel no
  editor. Depende de 4.1 existir pra decidir se comentário é por versão ou
  pelo design como um todo (sugestão: pelo design, mais simples).
- [ ] **4.4 Painel de código/handoff.** Painel read-only no editor mostrando
  o JSON do elemento selecionado e um botão "copiar" — bem mais simples que o
  do repo de referência (que mapeia pra arquivos-fonte reais, o que não faz
  sentido aqui já que não há geração de código por trás). Escopo reduzido
  deliberadamente.
- [ ] **4.5 Abas de múltiplos designs abertos.** Estado novo em
  `src/console/store.ts` (`openTabs: Array<{id, name}>`), UI de abas no topo
  do editor, persistir em localStorage (não em banco — é preferência de
  sessão do navegador, não dado do design).
- [ ] **4.6 Modo apresentação em tela cheia.** VERIFICAR PRIMEIRO: o editor já
  tem um botão "Apresentar em tela cheia" na barra de zoom
  (`editor.ts`, toolbar) — checar se já funciona de ponta a ponta (avança
  página, esconde chrome, Esc sai) antes de assumir que falta construir do
  zero.
- [ ] **4.7 Painel de design system/marca.** Paletas de cor/fonte salvas por
  conta, reaproveitáveis entre designs — tabela nova (`brand_kits`), painel
  no editor pra aplicar uma paleta salva.
- [ ] **4.8 Diálogo de login/cadastro em modal.** VERIFICAR PRIMEIRO: o
  backend já tem `/api/v1/auth/signup`+`/login` completos
  (`server/src/supabaseAuth.ts`) — o que falta é só a UI ser um diálogo modal
  em vez de página cheia (se for o caso; conferir como o console hoje pede
  login).
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
- [ ] **4.10 Erro: captura com TTL, página de erro offline, ponte pra
  relatório externo.** Adicionar um error boundary simples no React do
  console + um handler global de erro não capturado, com um cache de curta
  duração pra não duplicar o mesmo erro repetidamente. Decidir destino do
  "relatório externo" com o usuário (não assumir um serviço de terceiro sem
  perguntar).

## Notas de execução do loop

- Rodar `npm run check && npm test` (raiz, `server/`, e `pdf-import-service/`
  conforme o que foi tocado) antes de cada commit.
- Um commit por item concluído, mensagem descrevendo o item do backlog.
- Itens 4.1–4.10 pedem decisão de produto real — implementar com o padrão já
  estabelecido no resto do repo (isolamento por `ownerId`, RLS, testes no
  mesmo estilo de `app.test.ts`), mas parar e perguntar ao usuário se algo
  exigir uma escolha que mude a experiência de forma visível (ex.: o que
  "compartilhar" deveria significar, quem pode comentar).
