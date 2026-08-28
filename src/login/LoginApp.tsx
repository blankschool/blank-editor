import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { navigate } from "../router";
import { setSession, useSession, type Session } from "../session";
import { WORKSPACE } from "../console/workspace";
import { set } from "../console/store";
import "./login-grid.css";

/**
 * Um card central sobre um fundo de tela inteira: grid animado sobre --accent,
 * com a frase de produto acima do card. Pedido como o bloco pago
 * `@reui/auth-1` do reui.io — não instalei esse pacote. Três motivos, nenhum
 * contornável escrevendo em volta:
 *
 *  1. É um bloco Pro: o próprio workflow que veio junto diz para PARAR e pedir
 *     a licença se ela não estiver disponível. Não tenho REUI_LICENSE_KEY, e
 *     inventar uma chave não é uma opção.
 *  2. O workflow pressupõe `pnpm` e um projeto já inicializado pelo shadcn CLI
 *     (components.json). Este repo usa npm e não tem components.json de
 *     propósito — os componentes em src/components/ui são portados à mão,
 *     coordenados com os tokens deste app.css (ver o comentário longo lá sobre
 *     por que o Tailwind entra sem @layer). Rodar `shadcn init` por cima
 *     arrisca reescrever exatamente essa configuração.
 *  3. O registro reui.io é pensado para Next.js (App Router, "use client").
 *     Este projeto é Vite de propósito — foi a decisão central desta sessão.
 *
 * O que está aqui é a MESMA peça visual — grid mascarado, frase de produto,
 * card compacto — reconstruída com o que o projeto já tem. Sem Google, sem
 * Apple, sem logo e sem a foto do Unsplash, como pedido. Era split-screen
 * numa primeira versão; virou fundo único porque a tela ficava melhor com o
 * card centralizado sobre a peça, não ao lado dela.
 *
 * O modo entrar é intencionalmente curto — e-mail, senha, Entrar. O que a
 * criação de conta pede a mais (nome, força da senha) só aparece nesse modo,
 * dentro do mesmo card, em vez de virar uma segunda tela.
 *
 * Criar conta grava um workspace de verdade no Postgres (POST /api/v1/workspace)
 * e entrar busca esse mesmo workspace pelo e-mail (GET .../by-email/:email) —
 * ver session.ts para o porquê de isso ainda não ser uma sessão de servidor.
 * O campo "senha" continua sem verificação nenhuma: existe validação de
 * tamanho, mas nada aqui compara com um hash guardado. Isso é deliberado e
 * documentado no schema (server/schema.sql) — construir isso é trabalho maior
 * e separado, não algo para empacotar de graça junto do resto.
 */

type Mode = "login" | "signup";

const STRENGTH_LABELS = ["Muito fraca", "Fraca", "Razoável", "Boa", "Forte"];

function strengthScore(pw: string): number {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

function barColor(index: number, score: number): string {
  if (index >= score) return "var(--border)";
  if (score <= 1) return "var(--danger)";
  if (score === 2) return "var(--warning)";
  return "var(--success)";
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] font-medium leading-none">
        {label}
      </label>
      {children}
    </div>
  );
}

export function LoginApp() {
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Esta tela nunca desmonta (o router só alterna display), então "Sair" por si
  // só não limpa nada aqui — sem isto, quem criava conta e depois saía via
  // Sair via a tela de login voltar ainda em modo "Criar conta", com os campos
  // antigos preenchidos. O gatilho certo é a própria transição de sessão: só
  // reseta quando ela vai de presente para nula, que é exatamente o momento
  // de um logout — nunca no primeiro carregamento (sessão ausente desde o
  // início não é uma saída) nem enquanto alguém troca de aba manualmente entre
  // Entrar/Criar conta.
  const session = useSession();
  const hadSession = useRef(session !== null);
  useEffect(() => {
    if (hadSession.current && !session) {
      setMode("login");
      setName("");
      setEmail("");
      setPassword("");
      setReveal(false);
      setError("");
    }
    hadSession.current = session !== null;
  }, [session]);

  const login = mode === "login";
  const score = strengthScore(password);

  /** Erro some ao primeiro toque em qualquer campo. */
  function edit(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setError("");
    };
  }

  async function submit() {
    if (!email.trim() || !password) return setError("Preencha e-mail e senha para continuar.");
    if (!login && !name.trim()) return setError("Informe seu nome.");
    if (!login && password.length < 8) return setError("A senha precisa de pelo menos 8 caracteres.");
    setError("");
    setLoading(true);
    try {
      const session = login ? await signIn(email.trim(), password) : await signUp(name.trim(), email.trim(), password);
      setSession(session);
      // O router exige sessão para /console e /editor — sem chamar setSession
      // antes, o próprio navigate seria desfeito pelo gate no primeiro apply().
      navigate("console");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não deu para falar com o servidor agora.");
    } finally {
      setLoading(false);
    }
  }

  // `credentials: "include"` em ambas: é o que faz o navegador guardar o Set-Cookie
  // httpOnly que o servidor devolve — sem isso a sessão não persiste entre navegações.
  async function signIn(email: string, password: string): Promise<Session> {
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 401) throw new Error("E-mail ou senha incorretos.");
    if (!res.ok) throw new Error("Não deu para falar com o servidor agora.");
    return res.json();
  }

  async function signUp(name: string, email: string, password: string): Promise<Session> {
    const res = await fetch("/api/v1/auth/signup", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    if (res.status === 400) throw new Error((await res.json().catch(() => null))?.error ?? "Já existe uma conta com esse e-mail — entre em vez de criar.");
    if (!res.ok) throw new Error("Não deu para falar com o servidor agora.");
    const body = await res.json();
    // A chave "Chave padrão" só é mostrada em texto puro agora, no momento da criação — não tem
    // como recuperar depois. Guardar aqui faz ela aparecer já revelada na primeira vez que a
    // pessoa abrir "Chaves de API" (mesmo banner de "copie agora" que uma chave criada à mão usa).
    if (body.apiKey) set("newKeySecret", { id: body.apiKey.id, secret: body.apiKey.secret });
    return { id: body.id, name: body.name, email: body.email };
  }

  return (
    <div data-tw-root className="relative flex min-h-screen items-center justify-center overflow-hidden bg-accent p-4">
      <div aria-hidden className="login-grid login-grid--on-accent pointer-events-none absolute inset-0" />

      <div className="relative flex w-full max-w-md flex-col items-center gap-8 py-10">
        {/* A frase de produto, sempre visível — antes só aparecia dentro do card,
            e só no modo de criar conta. Como fundo virou tela inteira, ela sobe
            para fora do card e fica constante: é a mesma promessa para quem
            entra e para quem cria conta. */}
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="font-display text-3xl font-semibold leading-[1.15] tracking-tight text-on-accent sm:text-4xl">
            {WORKSPACE.tagline}
          </p>
          <p className="max-w-sm text-[15px] leading-relaxed text-on-accent/85">
            Escolha um modelo, nomeie as camadas e chame a API — o mesmo design, gerado quantas vezes precisar.
          </p>
        </div>

        <div className="w-full rounded-lg border border-line bg-surface shadow-pop">
          <form
            className="flex flex-col gap-4 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p className="text-center text-[13px] text-muted">
              {login ? "Entre com sua conta para continuar" : "Crie sua conta gratuitamente"}
            </p>

            {!login && (
              <Field id="loginName" label="Nome">
                <Input
                  id="loginName"
                  value={name}
                  onChange={(e) => edit(setName)(e.target.value)}
                  placeholder="Como devemos te chamar"
                  className="rounded-md bg-bg"
                />
              </Field>
            )}

            <Field id="loginEmail" label="E-mail">
              <Input
                id="loginEmail"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => edit(setEmail)(e.target.value)}
                placeholder="voce@empresa.com"
                className="rounded-md bg-bg"
              />
            </Field>

            <Field id="loginPassword" label="Senha">
              <div className="relative flex">
                <Input
                  id="loginPassword"
                  type={reveal ? "text" : "password"}
                  autoComplete={login ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => edit(setPassword)(e.target.value)}
                  placeholder="••••••••"
                  className="min-w-0 flex-1 rounded-md bg-bg pr-11"
                />
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  title={reveal ? "Ocultar senha" : "Mostrar senha"}
                  aria-label={reveal ? "Ocultar senha" : "Mostrar senha"}
                  className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-sm text-muted hover:bg-surface-2"
                >
                  {reveal ? <EyeOff size={15} strokeWidth={1.4} /> : <Eye size={15} strokeWidth={1.4} />}
                </button>
              </div>

              {!login && (
                <div className="flex flex-col gap-1.5 pt-1">
                  <div className="flex gap-1.5" aria-hidden>
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="h-[3px] flex-1 rounded-[2px]" style={{ background: barColor(i, score) }} />
                    ))}
                  </div>
                  <span className="text-[11px] text-faint" aria-live="polite">
                    {password ? `Força da senha: ${STRENGTH_LABELS[score]}` : "Use letras, números e um símbolo."}
                  </span>
                </div>
              )}
            </Field>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-danger-border bg-danger-bg px-3 py-2.5 text-[13px] text-danger"
              >
                {error}
              </div>
            )}

            <Button type="submit" size="lg" disabled={loading} className="w-full rounded-md text-[13px]">
              {loading ? "Entrando…" : login ? "Entrar" : "Criar conta"}
            </Button>

            <p className="text-center text-[13px] text-muted">
              {login ? "Não tem conta?" : "Já tem uma conta?"}{" "}
              <button
                type="button"
                onClick={() => {
                  setMode(login ? "signup" : "login");
                  setError("");
                }}
                className="font-medium text-accent hover:underline"
              >
                {login ? "Criar conta" : "Entrar"}
              </button>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
