import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { navigate } from "../router";

/**
 * Portado de src/pages/login.ts. Todo o cuidado de "não re-renderizar enquanto
 * o usuário digita" que existia lá — patch manual das barras de força, do
 * checkbox e do banner de erro, para o innerHTML não roubar o foco do input —
 * sai inteiro: input controlado do React mantém foco e cursor de graça. É o
 * ganho concreto desta migração nesta tela.
 *
 * O que NÃO mudou: não existe autenticação real por trás. O submit valida os
 * campos e navega para o console depois de 700ms, igual antes.
 */

type Mode = "login" | "signup";

const MODES = [
  { value: "login" as const, label: "Entrar" },
  { value: "signup" as const, label: "Criar conta" },
];

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

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
  }

  /** Erro some ao primeiro toque em qualquer campo — era o clearErrorLive() do original. */
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

  return (
    <div data-tw-root className="flex min-h-screen bg-ground text-text">
      <div className="flex flex-1 flex-col justify-center p-10">
        <form
          className="mx-auto flex w-full max-w-[360px] flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <span className="font-display text-[22px] font-semibold -tracking-[0.02em]">
              {login ? "Entrar na sua conta" : "Criar sua conta"}
            </span>
            <span className="text-[13px] text-faint">
              {login ? "Use o e-mail do seu workspace." : "Grátis até 200 renders por mês."}
            </span>
          </div>

          <Segmented
            aria-label="Entrar ou criar conta"
            value={mode}
            onValueChange={switchMode}
            options={MODES}
            size="tab"
            variant="solid"
            className="p-1 [&>*]:flex-1"
          />

          <Button type="button" variant="outline" size="lg" className="bg-surface text-text">
            <GoogleMark />
            Continuar com Google
          </Button>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-line" />
            <span className="text-[11px] uppercase tracking-[0.06em] text-faint">ou</span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <div className="flex flex-col gap-3">
            {!login && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="loginName" className="text-xs text-muted">
                  Nome
                </label>
                <Input
                  id="loginName"
                  value={name}
                  onChange={(e) => edit(setName)(e.target.value)}
                  placeholder="Como devemos te chamar"
                  className="bg-surface"
                />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="loginEmail" className="text-xs text-muted">
                E-mail
              </label>
              <Input
                id="loginEmail"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => edit(setEmail)(e.target.value)}
                placeholder="voce@empresa.com"
                className="bg-surface"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2.5">
                <label htmlFor="loginPassword" className="flex-1 text-xs text-muted">
                  Senha
                </label>
                {login && (
                  <a href="#" className="text-xs text-faint no-underline hover:text-muted">
                    Esqueci a senha
                  </a>
                )}
              </div>
              <div className="relative flex">
                <Input
                  id="loginPassword"
                  type={reveal ? "text" : "password"}
                  autoComplete={login ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => edit(setPassword)(e.target.value)}
                  placeholder={login ? "••••••••" : "Mínimo de 8 caracteres"}
                  className="min-w-0 flex-1 bg-surface pr-11"
                />
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  title={reveal ? "Ocultar senha" : "Mostrar senha"}
                  aria-label={reveal ? "Ocultar senha" : "Mostrar senha"}
                  className="absolute right-1.5 top-1.5 flex h-7.5 w-7.5 items-center justify-center rounded-sm text-muted hover:bg-surface-2"
                >
                  {reveal ? <EyeOff size={15} strokeWidth={1.4} /> : <Eye size={15} strokeWidth={1.4} />}
                </button>
              </div>

              {!login && (
                <div className="flex flex-col gap-1.5 pt-0.5">
                  <div className="flex gap-1.5" aria-hidden>
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="h-[3px] flex-1 rounded-[2px]"
                        style={{ background: barColor(i, score) }}
                      />
                    ))}
                  </div>
                  <span className="text-[11px] text-faint" aria-live="polite">
                    {password ? `Força da senha: ${STRENGTH_LABELS[score]}` : "Use letras, números e um símbolo."}
                  </span>
                </div>
              )}
            </div>

            {!login && (
              <label className="flex cursor-pointer items-start gap-2.5 pt-0.5">
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
                className="rounded-sm border border-danger-border bg-danger-bg px-3 py-2.5 text-xs text-danger"
              >
                {error}
              </div>
            )}

            <Button type="submit" size="lg" disabled={loading} className={cn("mt-0.5 h-10.5 text-[13px]")}>
              {loading ? "Entrando…" : login ? "Entrar" : "Criar conta"}
            </Button>
          </div>

          <span className="text-center text-xs text-faint">
            {login ? "Ainda não tem conta?" : "Já tem uma conta?"}{" "}
            <button
              type="button"
              onClick={() => switchMode(login ? "signup" : "login")}
              className="font-medium text-text no-underline hover:underline"
            >
              {login ? "Criar agora" : "Entrar"}
            </button>
          </span>
        </form>
      </div>
    </div>
  );
}
