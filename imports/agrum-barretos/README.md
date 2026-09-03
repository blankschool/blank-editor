# Agrum Jornal — capa de matéria

Reconstrução editável de `Cópia de Barretos como uma lona de circo virou um
negócio de R$600 milhões.pdf` (exportação em PDF de um design do Canva).

Não é o PDF rasterizado: cada camada é um elemento nomeado do documento do Blank
Editor — as fotos como `image`, os anéis como `ellipse`, o selo como `rect` +
`text`, o título como texto de verdade na fonte original.

## Como foi feito

```bash
cd server

# 1. camadas de imagem + posições (poppler + sharp)
node scripts/canva-pdf-extract.ts <arquivo.pdf> ../imports/agrum-barretos --width 1080

# 2. fontes embutidas no PDF, remapeadas por Unicode (venv com fontTools)
.venv/bin/python scripts/canva-pdf-fonts.py <arquivo.pdf> ../imports/agrum-barretos/fonts
cp ../imports/agrum-barretos/fonts/*.woff2 ../public/fonts/   # navegador
cp ../imports/agrum-barretos/fonts/*.ttf   fonts/             # fontconfig do container

# 3. nomear camadas e recriar texto/formas → manifest.json (à mão, é design)

# 4. sobe as imagens e cria o design pela própria API
BLANK_EDITOR_API_KEY=<chave> node scripts/canva-import.ts ../imports/agrum-barretos/manifest.json
```

O passo 3 é o único que não dá para automatizar: o nome da camada é a superfície
da API (`layers: { "titulo-valor": { text: "R$800 milhões" } }`), e decidir que a
foto grande é `fundo` e a pequena é `foto-historica` é julgamento de design.

## Camadas

| Nome | O que é |
| --- | --- |
| `fundo` | foto da arena, sangra nos quatro lados |
| `pessoa` | recorte com alfa real (soft-mask do PDF), por cima do fundo |
| `sombra` | degradê inferior que segura a leitura do título |
| `foto-historica`, `foto-historica-anel` | foto em círculo + anel verde |
| `selo`, `selo-anel` | emblema da Festa do Peão + anel verde |
| `categoria-fundo`, `categoria` | etiqueta verde e a palavra dentro dela |
| `marca` | "AGRUM JORNAL", em AniconSans |
| `titulo-*` | os seis trechos da manchete |

O título é **seis elementos**, não um. O documento tem uma cor e um peso por
elemento de texto, e a manchete alterna verde/branco e bold/light no meio da
frase — então cada trecho é seu próprio elemento, todos com `group: "titulo"`
para se moverem juntos no canvas. O preço: trocar o texto de um trecho não
reflui os outros, que estão posicionados pela largura medida do trecho anterior.
Se um dia valer mais ter um `titulo` só, editável pela API, do que a manchete
bicolor, é juntar os seis num elemento branco e apagar os cinco.

## Fontes

`fonts/` traz AniconSans e NYTFranklin (Light/Semibold/Bold) reconstruídas do
próprio PDF. Elas fazem o texto bater com o original em ~1px de largura e
posição; com substitutas (Inter/Oswald) a largura errava até 10% e a manchete
desencaixava.

**Cada face traz só os glifos que esta arte usa.** `NYTFranklin-Light` tem
`?acdegilmnoruvó` e mais nada — escrever uma palavra com "b" nesse trecho não
desenha nada. Para texto livre, ou se licencia a fonte inteira, ou se troca a
camada por uma família do seletor.
