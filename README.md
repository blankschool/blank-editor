# Blank Editor

Editor de canvas com uma API de renderização de verdade por trás (`server/`).
Templates desenhados no canvas viram recursos reais no servidor — não mais um
arquivo HTML único: é um app hospedado, com backend em Postgres/memória e uma
API que o n8n (ou qualquer cliente HTTP) pode chamar.

## Rodar

```bash
npm install              # uma vez
cd server && npm install # uma vez, as deps da API
cd ..

npm run dev              # front + API juntos, Ctrl+C encerra os dois
```

`npm run dev` sobe as duas metades porque separadas elas não formam um app: o
Vite faz proxy de `/api` para `127.0.0.1:8787`, e sem a API o console abre sem
nenhum design e o playground não renderiza. Se alguma das portas já estiver
ocupada o comando recusa subir e diz qual processo está na frente, em vez de
migrar de porta em silêncio.

Depois acesse `http://localhost:5173`. Em **Designs**, clique num card para
editar no canvas, ou use **Novo design** e escolha um dos três modelos (post,
story, carrossel) — todos já vêm com as camadas nomeadas que a API preenche. Para testar a API, vá em **Conta →
Desenvolvedor → Playground**, escolha o design, preencha os campos e clique em
**Gerar render**. A chave local é `blk_local_dev`; esse modo não precisa de
banco de dados.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | front (5173) + API de render (8787), com encerramento conjunto |
| `npm run dev:web` | só o Vite, para quando a API já está rodando por fora |
| `npm run build` | checa tipos e gera `dist/` |
| `npm run check` | só a checagem de tipos |
| `npm test` | testa o documento editável do Twitter |

## Estrutura

O app tem duas metades com tecnologias diferentes, e isso é intencional:

```
src/
├── main.tsx          entry: monta as raízes React e chama mountEditor()
├── router.ts         roteamento por hash (login/console/editor)
│
│   ── React + Tailwind + shadcn/ui ──
├── console/          store.ts (estado + ações), AppHeader, Sidebar e as views
│                     starterTemplates.ts: os 3 modelos de partida
├── login/            LoginApp.tsx
├── components/ui/    componentes shadcn (button, input, dialog, select…)
├── lib/utils.ts      cn()
├── app.css           tema Tailwind: tokens do shadcn como ALIAS do styles.css
│
│   ── DOM imperativo ──
├── editor.ts         núcleo do canvas: estado, render, entrada, painéis, exportação
├── styles.css        design system + todo o chrome do editor
├── chrome.css        ícones e hit targets do editor
│
│   ── compartilhado ──
├── templateStore.ts  fetch/create/save de templates no servidor, com cache local
├── types.ts          modelo do documento (El, Page, Doc)
├── theme.ts          claro/escuro/sistema
└── pdf.ts            escritor de PDF — módulo folha, sem estado do editor

scripts/dev.mjs       sobe front + API juntos (o `npm run dev`)
server/               API de render (Fastify) — ver server/README/Dockerfile
```

O console tem três destinos, não quatro: **Designs** (a home), **Novo design**
(ação) e **Conta**. Playground, importação de JSON e chaves de API vivem em
Conta → Desenvolvedor — são ferramentas de integração, e no menu principal
faziam a navegação descrever a API em vez do produto.

`editor.ts` continua sendo um módulo só, de propósito: `doc`, `sel`, `tool` e
`zoom` são lidos e escritos por quase toda função ali. Fatiar isso é refatoração
para fazer **atrás dos testes**, não antes deles. Por isso o editor **não** foi
migrado para React: `main.tsx` monta o markup fixo do `index.html` e chama
`mountEditor()` uma vez. Todo o chrome do editor (rail, painéis, toolbelt,
bottombar, modais) nasce de `innerHTML` dentro do `editor.ts`, amarrado a ~50
IDs do `index.html` — Tailwind não alcança nada disso, e é por isso que
`styles.css` continua existindo em vez de ser absorvido.

As duas metades compartilham **uma** fonte de verdade de cor. `app.css` não copia
valores: declara os tokens do Tailwind/shadcn como alias dos tokens semânticos do
`styles.css` (`--color-surface: var(--surface)`), que já resolvem claro/escuro em
três formas. Consequência prática: o console não tem uma única classe `dark:`, e
mudar uma cor no `styles.css` muda as duas metades juntas.

Duas armadilhas de cascata resolvidas em `app.css`, documentadas lá em detalhe:
o Tailwind entra **sem preflight** (um reset global zeraria o chrome do editor) e
**sem `@layer`** (estilo fora de layer vence estilo dentro de layer, então
`button { background: none }` do `styles.css` apagaria todo `bg-*` do console).

## API local

O endpoint `POST http://localhost:8787/api/v1/render` exige
`Authorization: Bearer blk_local_dev` e devolve o PNG diretamente. O Vite faz
proxy de `/api` para esse servidor, por isso o playground funciona em
`localhost:5173`.

```jsonc
{
  "template": "<id do design>",
  "page": 2,            // opcional; base 1, só faz sentido em design de várias páginas
  "layers": {
    "titulo": { "text": "Primeiro ponto" },
    "imagem": { "image_url": "https://exemplo.com/foto.jpg" },
    "rodape": { "hide": true }
  }
}
```

As chaves de `layers` são os **nomes das camadas** do design — um elemento sem
nome é decoração, não campo. Omitir uma camada mantém o que o editor salvou.

`page` existe por causa do carrossel. Sem ele o render devolvia sempre a página
ativa, então um design de três slides gerava três vezes a mesma capa. Os modelos
de carrossel usam os mesmos nomes de camada nas três páginas de propósito: é uma
chamada só, variando `page` de 1 a 3. Página fora do intervalo é recusada com
400 em vez de cair na mais próxima — devolver a página 3 para quem pediu a 4
faria o chamador acreditar que gerou o slide que pediu.

O servidor de produção continua aceitando `DATABASE_URL`; `dev:local` usa
somente a chave e os templates em memória.

## Geração editável pelo n8n

`POST /api/v1/generations` cria um design novo a partir de um design salvo, em
vez de sobrescrever o modelo. A rota exige uma chave de API do Blank e o header
`Idempotency-Key`; repetir a mesma chave devolve o mesmo design e preserva
qualquer correção manual que já tenha sido feita nele.

Um modelo de uma página funciona como card-base e é repetido para cada item de
`pages`. Em modelos que já têm várias páginas, a quantidade enviada precisa ser
idêntica. Todas as camadas informadas precisam existir na página e aceitar o
tipo enviado.

```jsonc
{
  "template": "ID_DO_DESIGN_BASE",
  "name": "Título do briefing",
  "pages": [
    {
      "layers": {
        "titulo": { "text": "Uma tese forte" },
        "corpo": { "text": "O argumento deste card." },
        "imagem": {
          "asset": {
            "strategy": "stock",
            "query": "professora brasileira em sala de aula",
            "aspectRatio": "4:5"
          }
        },
        "numero": { "text": "1/5" },
        "cta": { "text": "" }
      }
    }
  ]
}
```

A estratégia de imagem é sempre explícita: `stock` pesquisa no Pexels e `ai`
gera uma imagem pela OpenAI. Não existe fallback silencioso entre as duas. O
servidor copia os bytes para o Storage privado do Blank e registra fornecedor,
autor/licença ou prompt/modelo; `PEXELS_API_KEY` e `OPENAI_API_KEY` ficam apenas
no ambiente do servidor.

A resposta traz `generation.id`, os três estados da geração, `reviewPath`, o
novo design e uma URL assinada de preview por página. O preview ainda não é um
download público. O n8n deve
guardar a API key numa credencial, enviar `run_id` (ou o ID da execução) como
`Idempotency-Key` e montar a URL de edição como
`https://blank-editor.ickanz.easypanel.host${reviewPath}`. Reutilizar a mesma
chave com outro corpo retorna `409 IDEMPOTENCY_CONFLICT`.

### Aprovação e download

O documento em `templates` é a cópia editável. `design_versions` guarda os
snapshots imutáveis submetidos para revisão. Qualquer editor autenticado pode
usar:

- `POST /api/v1/generations/:id/submit` para enviar a versão atual;
- `POST /api/v1/generations/:id/approve` para aprovar a versão informada;
- `POST /api/v1/generations/:id/request-changes` com comentário obrigatório;
- `POST /api/v1/generations/:id/media/:page/:layer/regenerate` para trocar só
  a foto escolhida usando `stock` ou `ai`.

O editor esconde a exportação enquanto `canDownload` for falso. Aprovar
renderiza o snapshot e publica URLs versionadas; editar depois volta a cópia
atual para `draft`, bloqueia seu download e preserva a versão aprovada anterior.

## Publicar

`dist/` (frontend) e `server/` (API) são deploys separados — o frontend é
estático, o servidor precisa de Node + Postgres. Veja `server/Dockerfile` e
`server/.env.example`.
