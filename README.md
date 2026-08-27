# Blank Editor

Editor de canvas que roda inteiramente no navegador. O build gera **um HTML
único** e autocontido, publicável como Artifact — sem servidor, sem API, sem
banco.

## Rodar

```bash
npm install     # uma vez
npm run dev     # localhost com recarga instantânea
npm run build   # gera dist/index.html
```

| Comando | O que faz |
| --- | --- |
| `npm run dev` | servidor de desenvolvimento com hot reload |
| `npm run build` | checa tipos e gera `dist/index.html` (arquivo único) |
| `npm run check` | só a checagem de tipos |
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

## Publicar

`dist/index.html` é o entregável. Não há passo extra: é o mesmo arquivo que vai
para o Artifact.

## Limites do formato Artifact

- teto de **16MB** por arquivo — hoje em 6,2MB com um carrossel;
- sem CDN (o CSP bloqueia), então nada de bibliotecas em runtime; a única
  exceção é o Google Fonts;
- download só pela API do próprio Artifact, que é o que `Exportar` usa.
