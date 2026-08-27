# Blank Editor

Editor de canvas com uma API de renderização de verdade por trás (`server/`).
Templates desenhados no canvas viram recursos reais no servidor — não mais um
arquivo HTML único: é um app hospedado, com backend em Postgres/memória e uma
API que o n8n (ou qualquer cliente HTTP) pode chamar.

## Rodar

```bash
npm install     # uma vez
npm run dev     # localhost com recarga instantânea
npm run build   # gera dist/ (build normal, servido por qualquer host estático)
```

Para usar o playground e renderizar o template localmente, abra outro terminal:

```bash
cd server
npm install     # uma vez
npm run dev:local
```

Depois acesse `http://localhost:5173/#/console`. Em **Templates**, clique em
**Twitter mínimo** para editar no canvas. Volte ao console, ajuste nome, @,
texto e foto e clique em **Gerar imagem**. As alterações do canvas são salvas
no navegador e enviadas junto com o pedido de renderização. A chave local é
`blk_local_dev`; esse modo não precisa de banco de dados.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | servidor de desenvolvimento com hot reload |
| `npm run build` | checa tipos e gera `dist/` |
| `npm run check` | só a checagem de tipos |
| `npm test` | testa o documento editável do Twitter |
| `npm run test:fidelity` | compara o render com as referências do Figma |
| `npm run import:figma` | reconstrói `src/seed.json` a partir de `assets/` |

## Estrutura

```
src/
├── editor.ts     núcleo: estado, render, entrada, painéis, exportação
├── types.ts      modelo do documento (El, Page, Doc)
├── pdf.ts        escritor de PDF — módulo folha, sem estado do editor
├── styles.css
└── seed.json     design que abre por padrão (gerado pelo importador)

scripts/figma-import.mjs   converte a árvore do Figma em documento do editor
tests/fidelity.mjs         diff pixel a pixel contra ref/
assets/                    imagens, SVGs e a árvore crua do Figma
ref/                       PNGs exportados do Figma (baseline dos testes)
```

`editor.ts` continua sendo um módulo só, de propósito: `doc`, `sel`, `tool` e
`zoom` são lidos e escritos por quase toda função ali. Fatiar isso é refatoração
para fazer **atrás dos testes**, não antes deles.

## Testes de fidelidade

`tests/fidelity.mjs` renderiza cada página pelo caminho real de exportação e
compara com os PNGs do Figma em `ref/`, pixel a pixel. Os tetos ficam em
`tests/baseline.json`.

```bash
npm run test:fidelity                  # valida dist/
node tests/fidelity.mjs --target dist  # idem, explícito
node tests/fidelity.mjs --update       # regrava os tetos
```

Esses baselines pegaram quatro bugs de importação que **passavam despercebidos a
olho nu**:

1. elementos mais largos que um slide eram atribuídos só pelo centro e sumiam
   dos demais;
2. `clipsContent` era usado para escolher o slide, mas nunca recortava de fato —
   fotos vazavam por baixo de painéis semitransparentes;
3. `strokeAlign: OUTSIDE` era tratado como borda interna;
4. os ajustes de cor do preenchimento de imagem do Figma (`exposure`,
   `contrast`, `saturation`) eram ignorados.

A divergência média hoje é ~10%. O que sobra vem de três limites conhecidos: o
Figma tem `shadows`, `highlights` e `temperature` sem equivalente em CSS; as
fotos foram reamostradas para caber no teto de 16MB do Artifact; e o
antialiasing de texto do navegador difere do Figma. Slides sem foto ficam em
2,5%; com foto pesada, em ~16%.

## API local

O endpoint `POST http://localhost:8787/api/v1/render` exige
`Authorization: Bearer blk_local_dev` e devolve o PNG diretamente. O Vite faz
proxy de `/api` para esse servidor, por isso o playground funciona em
`localhost:5173`.

O servidor de produção continua aceitando `DATABASE_URL`; `dev:local` usa
somente a chave e o template em memória.

## Publicar

`dist/` (frontend) e `server/` (API) são deploys separados — o frontend é
estático, o servidor precisa de Node + Postgres. Veja `server/Dockerfile` e
`server/.env.example`.
