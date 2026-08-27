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

Para usar o playground e renderizar templates localmente, abra outro terminal:

```bash
cd server
npm install     # uma vez
npm run dev:local
```

Depois acesse `http://localhost:5173`. Em **Templates**, clique num card para
editar no canvas, ou **Novo template** / **Importar → JSON** para criar um.
Volte ao console, escolha o template no **Playground**, preencha os campos e
clique em **Gerar render**. A chave local é `blk_local_dev`; esse modo não
precisa de banco de dados.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | servidor de desenvolvimento com hot reload |
| `npm run build` | checa tipos e gera `dist/` |
| `npm run check` | só a checagem de tipos |
| `npm test` | testa o documento editável do Twitter |

## Estrutura

```
src/
├── editor.ts        núcleo do canvas: estado, render, entrada, painéis, exportação
├── templateStore.ts fetch/create/save de templates no servidor, com cache local
├── types.ts         modelo do documento (El, Page, Doc)
├── pdf.ts           escritor de PDF — módulo folha, sem estado do editor
├── router.ts         roteamento por hash (login/console/editor)
├── pages/            console.ts, login.ts
└── styles.css

server/               API de render (Fastify) — ver server/README/Dockerfile
```

`editor.ts` continua sendo um módulo só, de propósito: `doc`, `sel`, `tool` e
`zoom` são lidos e escritos por quase toda função ali. Fatiar isso é refatoração
para fazer **atrás dos testes**, não antes deles.

## API local

O endpoint `POST http://localhost:8787/api/v1/render` exige
`Authorization: Bearer blk_local_dev` e devolve o PNG diretamente. O Vite faz
proxy de `/api` para esse servidor, por isso o playground funciona em
`localhost:5173`.

O servidor de produção continua aceitando `DATABASE_URL`; `dev:local` usa
somente a chave e os templates em memória.

## Publicar

`dist/` (frontend) e `server/` (API) são deploys separados — o frontend é
estático, o servidor precisa de Node + Postgres. Veja `server/Dockerfile` e
`server/.env.example`.
