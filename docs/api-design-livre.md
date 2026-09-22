# Criar um design do zero vs. gerar variações de um template

> **Se você (LLM ou humano) quer criar um design do zero com elementos novos
> (texto, imagem, forma, linha), use `POST /api/v1/templates` com o documento
> completo. NÃO use `POST /api/v1/generations` pra isso — essa rota serve só
> pra preencher/sobrescrever camadas de um template que já existe e já tem
> esses elementos desenhados.**

Isso já causou confusão real: um LLM externo tentou criar um design do zero
chamando `/api/v1/generations` e travou com:

```json
{ "error": "page 1 has unknown layer: titulo" }
```

O erro é esperado e correto — a rota errada foi usada. Veja abaixo por quê.

## As duas rotas, lado a lado

| | `POST /api/v1/templates` | `POST /api/v1/generations` |
|---|---|---|
| Cria elementos novos? | **Sim** — o `document` é livre | **Não** — só preenche camadas (`name`) que já existem no template-base |
| Precisa de um template-base já pronto? | Não | **Sim**, com elementos nomeados (`name`) no lugar certo |
| Uso típico | Criar um design do zero, importar um layout, montar qualquer estrutura nova | Gerar em lote variações de um template fixo (ex.: mesmo carrossel, texto/foto diferentes a cada chamada) |
| Erro `unknown layer: <nome>` pode acontecer? | Não é possível — não existe conceito de "camada nomeada obrigatória" nessa rota | **Sim**, se o template de origem não tiver um elemento com esse `name` (ou tiver `els: []`) |
| Validação do `document`/body | Nenhuma — `document: unknown`, sem schema (ver `server/src/db.ts`) | Valida `template`, `name`, `pages[].layers` e que cada camada referenciada exista e aceite o tipo enviado (`server/src/generationDocument.ts`) |
| Depois de criar | `POST /api/v1/render` com `{"template": "<id>"}` gera o PNG | A resposta já vem com `design.pages[].pngUrl` (preview assinado) |

Referência no código: `server/src/app.ts`, rota `POST /api/v1/templates` (por
volta da linha 808) e rota `POST /api/v1/generations` (por volta da linha
438). A checagem de camada desconhecida está em
`server/src/generationDocument.ts`, função `buildGeneratedDocument`.

## Quando usar cada uma

- **Quero montar um design novo, com os elementos que eu escolher (texto,
  imagem, forma, linha), do zero.** → `POST /api/v1/templates`.
- **Já existe um template salvo com camadas nomeadas (`titulo`, `imagem`,
  `corpo`...) e eu só quero trocar o texto/imagem/visibilidade delas, repetindo
  isso várias vezes com dados diferentes (ex.: um carrossel de 5 cards a
  partir de um briefing).** → `POST /api/v1/generations`.

Se a intenção é "criar do zero" e a única coisa disponível é um `template` que
não tem os elementos desejados (ou tem `els: []`), a resposta certa não é
inventar nomes de camada — é usar `/api/v1/templates` e desenhar os elementos
no `document`.

## Exemplo mínimo — `POST /api/v1/templates` (criar do zero)

Cria um design com um retângulo de fundo e um texto, em uma página de
1080x1350 (formato retrato comum de post/carrossel).

```
POST /api/v1/templates
Authorization: Bearer <sua API key>
Content-Type: application/json
```

```json
{
  "name": "Meu design do zero",
  "document": {
    "active": 0,
    "pages": [
      {
        "w": 1080,
        "h": 1350,
        "bg": "#111111",
        "els": [
          {
            "id": "bg-1",
            "type": "rect",
            "name": "fundo",
            "x": 0,
            "y": 0,
            "w": 1080,
            "h": 1350,
            "rot": 0,
            "opacity": 1,
            "locked": false,
            "hidden": false,
            "fill": "#111111",
            "stroke": "transparent",
            "strokeWidth": 0,
            "radius": 0
          },
          {
            "id": "txt-1",
            "type": "text",
            "name": "titulo",
            "x": 80,
            "y": 560,
            "w": 920,
            "h": 240,
            "rot": 0,
            "opacity": 1,
            "locked": false,
            "hidden": false,
            "fill": "#ffffff",
            "stroke": "transparent",
            "strokeWidth": 0,
            "radius": 0,
            "text": "Uma tese forte",
            "font": "Inter",
            "size": 64,
            "weight": 700,
            "align": "left",
            "lh": 1.2
          }
        ]
      }
    ]
  }
}
```

Resposta (201):

```json
{ "id": "<id do novo design>" }
```

(Se a verificação automática de layout detectar algo visualmente quebrado,
a resposta também inclui `layoutWarnings` — ver seção abaixo.)

Em seguida, para gerar o PNG:

```
POST /api/v1/render
Authorization: Bearer <sua API key>
Content-Type: application/json
```

```json
{ "template": "<id do novo design>" }
```

## Exemplo mínimo — `POST /api/v1/generations` (preencher template existente)

Só funciona se `<ID_DO_DESIGN_BASE>` já for um template salvo cujas páginas
tenham elementos com `name: "titulo"`, `name: "imagem"` etc. (por exemplo, o
design criado no exemplo acima, que já tem a camada `titulo`).

```
POST /api/v1/generations
Authorization: Bearer <sua API key>
Idempotency-Key: <chave única por execução, ex.: run_id do n8n>
Content-Type: application/json
```

```json
{
  "template": "<ID_DO_DESIGN_BASE>",
  "name": "Título do briefing",
  "pages": [
    {
      "layers": {
        "titulo": { "text": "Uma tese forte" }
      }
    }
  ]
}
```

Resposta (201), resumida:

```json
{
  "generation": { "id": "...", "reviewPath": "/#/editor/<id>?review=1", "..." : "..." },
  "design": {
    "id": "...",
    "pages": [{ "page": 1, "pngUrl": "https://..." }]
  }
}
```

Se `titulo` não existir na página 1 do template base (ou o template não tiver
elementos), a resposta é `400` com exatamente o erro que motivou este
documento:

```json
{ "error": "page 1 has unknown layer: titulo" }
```

## Verificação automática de layout (`layoutWarnings`)

`POST /api/v1/templates`, `POST /api/v1/generations` e outras rotas que
criam/editam/importam um design rodam, depois da operação, uma verificação
automática de layout sobre as páginas resultantes. Ela é aditiva e nunca
bloqueia a resposta: se detectar algo que parece visualmente quebrado — por
exemplo, elementos quase sobrepostos com ângulos bem diferentes, ou texto que
provavelmente estoura a caixa — a resposta inclui um campo `layoutWarnings`
(lista de avisos com página, elementos envolvidos, descrição e severidade
`baixa`/`média`/`alta`). Quando não há nada a reportar, o campo simplesmente
não aparece na resposta.

Implementação: `server/src/app.ts`, funções `checkLayoutWarnings` e
`toLayoutWarnings` (por volta da linha 217–251).

TODO: expandir esta seção com exemplos reais de `layoutWarnings` quando a
verificação automática de layout estiver mais madura em produção (mais casos
cobertos, formato final estabilizado).
