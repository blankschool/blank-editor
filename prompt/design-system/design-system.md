# Design System — x-creator-buddy

Extraído de `src/index.css`, `tailwind.config.ts` e `src/components/ui/*`.
Stack: React + Vite + TypeScript + Tailwind CSS v3 + shadcn/ui (Radix).

**Regra de ouro:** nunca usar classes de cor literais (`text-white`, `bg-black`, `bg-[#...]`) em componentes. Sempre tokens semânticos.

---

## 1. Paleta de cores

### Light (padrão)

| Papel | Token | HSL | Hex |
|---|---|---|---|
| Background | `--background` | `0 0% 100%` | `#FFFFFF` |
| Surface / Card | `--card`, `--popover` | `0 0% 100%` | `#FFFFFF` |
| Text (primário) | `--foreground` | `210 34% 11%` | `#131C26` |
| Text (secundário/muted) | `--muted-foreground` | `201 17% 37%` | `#4E636E` |
| Muted / Surface sutil | `--muted`, `--secondary`, `--accent` | `210 20% 96%` | `#F3F5F7` |
| Primary (marca/ação) | `--primary` | `203 89% 53%` | `#1CA0F2` |
| Primary foreground | `--primary-foreground` | `0 0% 100%` | `#FFFFFF` |
| Border / Input | `--border`, `--input` | `210 20% 91%` | `#E3E8ED` |
| Focus ring | `--ring` | `203 89% 53%` | `#1CA0F2` |
| Error / Destructive | `--destructive` | `0 84% 60%` | `#EF4343` |
| Success *(proposto)* | `--success` | `142 71% 40%` | `#1CAE55` |

### Dark

| Papel | Token | HSL | Hex |
|---|---|---|---|
| Background | `--background` | `0 0% 0%` | `#000000` |
| Surface / Card | `--card` | `210 20% 6%` | `#0C0F12` |
| Text (primário) | `--foreground` | `0 0% 85%` | `#D9D9D9` |
| Text (secundário) | `--muted-foreground` | `206 5% 47%` | `#72797E` |
| Muted / Surface sutil | `--muted`, `--secondary`, `--accent` | `210 20% 12%` | `#181F25` |
| Primary | `--primary` | `203 89% 53%` | `#1CA0F2` |
| Border / Input | `--border` | `200 10% 20%` | `#2E3538` |
| Error | `--destructive` | `0 62.8% 30.6%` | `#7F1D1D` |
| Success *(proposto)* | `--success` | `142 60% 38%` | `#279B53` |

**Decisões deliberadas**
- Dark usa preto puro `#000000` (paridade com o X), e o texto **nunca** é branco puro — sempre `#D9D9D9`.
- Existe uma paleta paralela `x.*` (`--x-blue`, `--x-dark`, `--x-gray`, `--x-light-gray`, `--x-hover`) usada **apenas** no preview do post, para simular a UI do X independentemente do tema da aplicação.
- Lacuna atual: não há token de `success`/`warning`. Confirmações usam toasts neutros. Valores acima são sugestões prontas para adotar.

---

## 2. Tipografia

| Família | Uso | Tailwind |
|---|---|---|
| **Inter** (Google Fonts, 400/500/600/700) | Toda a interface | `font-sans` (default) |
| **TwitterChirp** | Somente conteúdo dentro do preview de post / export em canvas | `font-twitter` |

Escala (Tailwind default, `line-height` entre parênteses):

| Papel | Classe | Tamanho | Peso |
|---|---|---|---|
| H1 / título de app | `text-xl font-bold` | 20px (28) | 700 |
| H2 / título de seção | `text-2xl font-bold` | 24px (32) | 700 |
| H3 / título de card | `text-lg font-semibold` | 18px (28) | 600 |
| Card title (shadcn) | `text-2xl font-semibold tracking-tight leading-none` | 24px | 600 |
| Body | `text-base` | 16px (24) | 400 |
| Body compacto / UI | `text-sm` | 14px (20) | 400–500 |
| Caption / meta | `text-xs text-muted-foreground` | 12px (16) | 400 |
| Label de botão | `text-sm font-medium` | 14px | 500 |

Regras: um único `h1` por página; corpo em `antialiased`; `tracking-tight` reservado a títulos grandes.

---

## 3. Espaçamento

Escala Tailwind base **4px** (`1 = 0.25rem`). Padrões efetivamente usados:

| Contexto | Valor |
|---|---|
| Gap entre ícone e texto | `gap-1.5` / `gap-2` (6–8px) |
| Gap entre botões | `gap-2` (8px) |
| Grid de cards | `gap-4` (16px) |
| Padding interno de card | `p-6` (24px) |
| Padding de página | `px-4 sm:px-6 lg:px-8`, `py-8` |
| Altura do header | `h-16` (64px) |
| Largura máxima de conteúdo | `max-w-5xl mx-auto` |
| Bloco vertical de seções | `space-y-4` / `mb-8` |

---

## 4. Border radius e sombras

**Radius** — base `--radius: 0.75rem` (12px)
- `rounded-lg` = 12px → cards, containers, tabs de slide
- `rounded-md` = 10px → botões, inputs, selects
- `rounded-sm` = 8px → elementos densos
- `rounded-full` → avatares, botões-ícone, badges

**Sombras** — deliberadamente discretas (visual flat, hierarquia via borda)
- `shadow-sm` → cards em repouso
- `shadow-lg` → item em drag, popovers, dialogs
- Header não usa sombra: `border-b` + `bg-background/80 backdrop-blur-md`

**Animações** (`tailwind.config.ts`): `fade-in` (0.3s, translateY 10px), `scale-in` (0.2s, 0.95→1), `accordion-down/up` (0.2s). Transições padrão: `transition-colors duration-200`.

---

## 5. Componentes recorrentes

```tsx
// Botão primário
<Button>Novo Perfil</Button>
// bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2 rounded-md text-sm font-medium

// Botão secundário / outline (ação de apoio no header)
<Button variant="outline" size="sm">Sair</Button>
// border border-input bg-background hover:bg-accent hover:text-accent-foreground

// Botão ghost (ações contextuais, revelam no hover do card)
<Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100" />

// Botão destrutivo
<Button variant="destructive">Excluir</Button>

// Input
// h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm
// focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2

// Card
// rounded-lg border bg-card text-card-foreground shadow-sm
// header/content/footer: p-6 (content e footer com pt-0)
// interativo: cursor-pointer hover:border-primary/50 transition-colors group

// Navbar / header
<header className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
  <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
    <div className="flex items-center justify-between h-16"> … </div>
  </div>
</header>

// Tab bar (slides do carrossel, PostTabs)
// px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
// ativo: bg-primary/10 text-primary  |  inativo: text-muted-foreground hover:bg-accent
// drag ativo: shadow-lg  |  botão de remover: rounded-full, opacity-0 group-hover:opacity-100

// Avatar
<Avatar className="w-14 h-14"> <AvatarImage/> <AvatarFallback className="text-lg"/> </Avatar>
```

Todos os primitivos vêm de shadcn/ui + Radix; ícones de `lucide-react` em `w-4 h-4` (UI) ou `w-5 h-5` (badges). Ícones de marca customizados: `XLogo`, `VerifiedIcon`.

---

## 6. Estilo geral em 3 palavras

**Clean · funcional · X-nativo**

Interface utilitária que desaparece para dar palco ao preview do post: neutros frios, um único azul de acento, bordas em vez de sombras, densidade média e paridade visual deliberada com a UI do X/Twitter.

---

## 7. Padrões de UX

**Navegação** — hierarquia em 3 níveis, sempre com botão "voltar" explícito:
```text
/                                   Lista de perfis
└─ /profile/:id                     Posts do perfil (+ busca, Membros, Histórico no header)
   └─ /profile/:id/post/:postId     Editor de slides
```
Rotas laterais: `/profile/:id/edit`, `/members`, `/history`. Auth em `/auth`; cadastro só pela rota oculta `/setup/a7x9k2`. Tudo atrás de `ProtectedRoute`.

**Hierarquia** — header sticky com identidade + ações globais → título de seção com subtítulo em `muted-foreground` → grade de cards (`sm:grid-cols-2 lg:grid-cols-3`). A ação primária fica sempre no canto superior direito do bloco de conteúdo.

**Feedback**
- Carregamento: `Loader2` com `animate-spin` centralizado em tela cheia; skeletons não são usados.
- Sucesso/erro: `toast()` curto com título + descrição; erro usa `variant: "destructive"`.
- Ações destrutivas: sempre `AlertDialog` com consequência explicitada e botão confirmar em `bg-destructive`.
- Estado vazio: card `border-dashed` com ícone em círculo `bg-muted`, título, texto de apoio e CTA.
- Persistência: autosave debounced (1s) no editor; preferências de visualização em `localStorage` por post.
- Ações secundárias revelam-se no hover do card (`opacity-0 group-hover:opacity-100`), mantendo a grade limpa.

**Idioma da UI:** português (pt-BR), incluindo datas (`toLocaleDateString('pt-BR')`).

---

## Tokens

Os tokens completos em CSS variables estão em `docs/design-tokens.css`.
