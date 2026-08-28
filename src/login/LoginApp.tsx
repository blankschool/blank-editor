import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { navigate } from "../router";
import { WORKSPACE } from "../console/workspace";

/**
 * Card central, no formato de tela de entrada de SaaS: marca, título, uma linha
 * de apoio, campos rotulados, um botão de largura cheia e um link embaixo. A
 * versão anterior espalhava tudo numa coluna solta de 360px sem moldura, com o
 * seletor Entrar/Criar conta competindo com o título logo acima.
 *
 * O modo entrar é intencionalmente curto — e-mail, senha, Entrar. O que a
 * criação de conta pede a mais (nome, força da senha, termos) só aparece nesse
 * modo, dentro do mesmo card, em vez de virar uma segunda tela.
 *
 * Continua sem autenticação de verdade por trás: valida os campos e navega para
 * o console depois de 700ms. Não é a rota de boot justamente por isso.
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

function BrandMark() {
  return (
    <div
      aria-hidden
      className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent font-display text-[22px] font-bold leading-none text-on-accent"
    >
      B
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" className="shrink-0" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.4 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.5 34.8 26.9 36 24 36c-5.3 0-9.7-3.1-11.3-7.9l-6.5 5C9.6 39.7 16.3 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6.5 5.5C40.9 36.4 44 30.9 44 24c0-1.2-.1-2.4-.4-3.5z" />
    </svg>
  );
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
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(submitTimer.current), []);

  const login = mode === "login";
  const score = strengthScore(password);

  /** Erro some ao primeiro toque em qualquer campo. */
  function edit(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setError("");
    };
  }

  function submit() {
    if (!email.trim() || !password) return setError("Preencha e-mail e senha para continuar.");
    if (!login && !name.trim()) return setError("Informe seu nome.");
    if (!login && password.length < 8) return setError("A senha precisa de pelo menos 8 caracteres.");
    if (!login && !terms) return setError("Aceite os termos para criar a conta.");
    setError("");
    setLoading(true);
    clearTimeout(submitTimer.current);
    submitTimer.current = setTimeout(() => navigate("console"), 700);
  }

  // bg-bg (branco puro, #FFFFFF), não bg-ground (#E3E8ED) — o ground é o chumbo
  // do stage do editor, feito para dar contraste a artboards que também são
  // brancos. A tela de login não tem artboard nenhum, então herdar aquele cinza
  // só deixava tudo com aparência empoeirada em vez de limpa.
  return (
    <div data-tw-root className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface shadow-pop">
        <div className="flex flex-col items-center gap-4 p-6 text-center">
          <BrandMark />
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-2xl font-semibold -tracking-[0.02em]">
              {login ? WORKSPACE.brand : `Criar conta na ${WORKSPACE.brand}`}
            </h1>
            <p className="text-[13px] text-muted">
              {login ? "Entre com sua conta para continuar" : WORKSPACE.tagline}
            </p>
          </div>
        </div>

        <form
          className="flex flex-col gap-4 p-6 pt-0"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
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

          {!login && (
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={terms}
                onCheckedChange={(checked) => {
                  setTerms(checked === true);
                  setError("");
                }}
                className="mt-px"
              />
              <span className="text-xs leading-[1.55] text-muted">
                Aceito os termos de uso e a política de privacidade.
              </span>
            </label>
          )}

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

          {/* Abaixo do botão e sem divisor gritante: entrar por e-mail é o caminho
              principal desta tela, o social é alternativa. */}
          <Button type="button" variant="outline" size="lg" className="w-full rounded-md bg-bg text-[13px] text-text">
            <GoogleMark />
            Continuar com Google
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
  );
}
