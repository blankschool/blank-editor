import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { navigate } from "../router";
import { setSession } from "../session";
import { WORKSPACE } from "../console/workspace";

/**
 * Card central, minimalista: uma linha de apoio, campos rotulados, um botão de
 * largura cheia e um link embaixo. Sem marca nem título grande no topo — o
 * card inteiro já é a tela, não precisa se apresentar antes de pedir e-mail e
 * senha. Sem login social por ora: um caminho só, sem alternativa a manter.
 *
 * O modo entrar é intencionalmente curto — e-mail, senha, Entrar. O que a
 * criação de conta pede a mais (nome, força da senha) só aparece nesse modo,
 * dentro do mesmo card, em vez de virar uma segunda tela.
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
    setError("");
    setLoading(true);
    clearTimeout(submitTimer.current);
    // O router agora exige sessão para /console e /editor — sem isto o form
    // continuaria "funcionando" visualmente mas o próprio submit seria
    // redirecionado de volta para cá pelo gate.
    submitTimer.current = setTimeout(() => {
      setSession(email.trim());
      navigate("console");
    }, 700);
  }

  // bg-bg (branco puro, #FFFFFF), não bg-ground (#E3E8ED) — o ground é o chumbo
  // do stage do editor, feito para dar contraste a artboards que também são
  // brancos. A tela de login não tem artboard nenhum, então herdar aquele cinza
  // só deixava tudo com aparência empoeirada em vez de limpa.
  return (
    <div data-tw-root className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface shadow-pop">
        <form
          className="flex flex-col gap-4 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="text-center text-[13px] text-muted">
            {login ? "Entre com sua conta para continuar" : WORKSPACE.tagline}
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
  );
}
