# Renovação de login e biblioteca global de fontes

Correção de 25/09/2026. O commit contém apenas alterações de login e biblioteca de fontes, preparado em clone isolado para preservar o trabalho simultâneo no importador de PDF.

## Causas reproduzidas

- O servidor validava apenas o access token. Com esse cookie expirado ou ausente, `/auth/me` respondia 401 mesmo com refresh token válido. O frontend não chamava a rota de refresh existente.
- `listFontFaces` filtrava pelo dono. O painel não buscava o catálogo persistido e só mostrava fontes do documento aberto; selecionar uma família não incorporava seus arquivos ao novo design.

## Correções

As rotas protegidas renovam a sessão por cookie e devolvem os cookies rotacionados. Requisições concorrentes da mesma sessão compartilham o refresh em andamento; sessões distintas usam clientes Supabase isolados. Falhas transitórias preservam os cookies e retornam 503; refresh inválido exige novo login. O tempo de validade do JWT não foi ampliado.

A listagem retorna as fontes de todos os usuários autenticados, deduplicadas por hash. A autoria e as restrições de escrita permanecem. O painel consulta essa biblioteca ao abrir; ao aplicar uma família, carrega os arquivos e grava as referências em `Doc.fonts`, preservando versões já incorporadas ao documento.

## Pesquisa e consulta ao Jev

- [Supabase: sessões e rotação de refresh tokens](https://supabase.com/docs/guides/auth/sessions).
- [Supabase: considerações de autenticação no servidor](https://supabase.com/docs/guides/auth/server-side/advanced-guide).
- [MDN: FontFace](https://developer.mozilla.org/en-US/docs/Web/API/FontFace).
- [TypeSafe: API de perguntas estruturadas](https://docs.typesafe.ai/api).

O Jev `jev-1.13.0` recebeu as reproduções, achados do código, resumos das fontes e alternativas. Selecionou renovação no servidor e catálogo global com persistência no documento, ambos com confiança reportada 1,0. As perguntas sobre isolamento de refresh entre usuários e preservação de faces do documento retornaram 0,89 e 0,87. Esses resultados orientaram a implementação; a confirmação veio dos testes, não das probabilidades.

## Validação

- Frontend: 71 testes passando; TypeScript e build passando.
- Servidor: suíte com 293 testes passando e 1 ignorado, incluindo upload pela rota Fastify com storage simulado.
- Sessão: cookie ausente/expirado, refresh concorrente, isolamento entre usuários, revogação e falha transitória.
- SQL real de `db.ts` e migration executados em PostgreSQL embarcado (PGlite), em banco descartável: leitura entre usuários, deduplicação e RLS sem permissão de apagar fonte alheia. A integração Supabase local não foi executada porque o Docker estava desligado.
- Chromium com frontend real e API simulada: importar, atualizar página, aplicar em outro design, atualizar novamente e repetir com outra sessão de usuário.
- `npm --prefix server run check` ainda aponta problemas fora desta correção: stub incompleto em `app.layoutWarnings.test.ts` e declaração ausente do módulo `wawoff2`.

## Publicação

Aplicar `supabase/migrations/0011_global_font_library.sql` pelo fluxo de migrations do ambiente e publicar backend e frontend. A migration libera leitura da tabela para usuários autenticados; os registros existentes entram automaticamente no catálogo, sem reimportação. O SFNT continua no bucket privado existente e o navegador usa o arquivo web público.
