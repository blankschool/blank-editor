import { navigate } from "../router";

/**
 * Ported from Login.dc.html. That runtime re-renders on every keystroke and
 * still keeps focus, because it reconciles a virtual DOM. Plain innerHTML
 * replacement doesn't: rebuilding the tree while an input is focused detaches
 * it, and the cursor — and sometimes focus itself — is gone. So typing never
 * triggers a full render() here; it only ever writes into `state` and, where
 * the original showed live feedback (password strength, the error banner),
 * patches just that one element directly. Full render() is reserved for
 * discrete actions — switching tabs, submitting — where there's no focused
 * text field to lose.
 */

type Mode = "login" | "signup";

interface State {
  mode: Mode;
  name: string;
  email: string;
  password: string;
  reveal: boolean;
  terms: boolean;
  error: string;
  loading: boolean;
}

const state: State = {
  mode: "login", name: "", email: "", password: "",
  reveal: false, terms: false, error: "", loading: false,
};

let root: HTMLElement;
let submitTimer: ReturnType<typeof setTimeout> | undefined;
let bound = false;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function strengthScore(pw: string): number {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}
const STRENGTH_LABELS = ["Muito fraca", "Fraca", "Razoável", "Boa", "Forte"];
const barColor = (i: number, score: number) =>
  i >= score ? "var(--border)" : score <= 1 ? "var(--danger)" : score === 2 ? "var(--warning)" : "var(--success)";

function paintStrength() {
  if (state.mode !== "signup") return;
  const score = strengthScore(state.password);
  const bars = document.getElementById("pwBars");
  if (bars) {
    [...bars.children].forEach((el, i) => {
      (el as HTMLElement).style.background = barColor(i, score);
    });
  }
  const label = document.getElementById("pwLabel");
  if (label) {
    label.textContent = state.password
      ? "Força da senha: " + STRENGTH_LABELS[score]
      : "Use letras, números e um símbolo.";
  }
}

function clearErrorLive() {
  if (!state.error) return;
  state.error = "";
  document.getElementById("loginError")?.remove();
}

function submit() {
  const s = state;
  if (!s.email.trim() || !s.password) return showError("Preencha e-mail e senha para continuar.");
  if (s.mode === "signup" && !s.name.trim()) return showError("Informe seu nome.");
  if (s.mode === "signup" && s.password.length < 8) return showError("A senha precisa de pelo menos 8 caracteres.");
  if (s.mode === "signup" && !s.terms) return showError("Aceite os termos para criar a conta.");
  state.error = "";
  state.loading = true;
  render();
  clearTimeout(submitTimer);
  submitTimer = setTimeout(() => navigate("console"), 700);
}

function showError(msg: string) {
  state.error = msg;
  render();
}

function render() {
  const s = state;
  const login = s.mode === "login";
  const score = strengthScore(s.password);

  root.innerHTML = `
    <div style="min-height:100vh; display:flex; background:var(--ground); color:var(--text); font-family:var(--body); font-size:13px;">
      <div style="flex:1; display:flex; flex-direction:column; justify-content:center; padding:40px;">
        <div style="width:100%; max-width:360px; margin:0 auto; display:flex; flex-direction:column; gap:20px;">

          <div style="display:flex; flex-direction:column; gap:7px;">
            <span style="font-family:var(--display); font-size:22px; font-weight:600; letter-spacing:-0.02em;">${login ? "Entrar na sua conta" : "Criar sua conta"}</span>
            <span style="font-size:13px; color:var(--faint);">${login ? "Use o e-mail do seu workspace." : "Grátis até 200 renders por mês."}</span>
          </div>

          <div style="display:flex; align-items:center; gap:4px; padding:4px; border-radius:10px; border:1px solid var(--border); background:var(--surface);">
            <div data-action="go-login" style="cursor:pointer; flex:1; height:32px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:500; background:${login ? "var(--accent)" : "transparent"}; color:${login ? "var(--on-accent)" : "var(--muted)"};">Entrar</div>
            <div data-action="go-signup" style="cursor:pointer; flex:1; height:32px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:500; background:${login ? "transparent" : "var(--accent)"}; color:${login ? "var(--muted)" : "var(--on-accent)"};">Criar conta</div>
          </div>

          <div style="cursor:pointer; height:40px; border-radius:8px; border:1px solid var(--border); background:var(--surface); display:flex; align-items:center; justify-content:center; gap:9px; font-size:13px; font-weight:500;">
            <svg width="16" height="16" viewBox="0 0 48 48" style="flex-shrink:0;">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z"/>
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
              <path fill="#4CAF50" d="M24 44c5.4 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.5 34.8 26.9 36 24 36c-5.3 0-9.7-3.1-11.3-7.9l-6.5 5C9.6 39.7 16.3 44 24 44z"/>
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6.5 5.5C40.9 36.4 44 30.9 44 24c0-1.2-.1-2.4-.4-3.5z"/>
            </svg>
            <span>Continuar com Google</span>
          </div>

          <div style="display:flex; align-items:center; gap:12px;">
            <div style="flex:1; height:1px; background:var(--border);"></div>
            <span style="font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--faint);">ou</span>
            <div style="flex:1; height:1px; background:var(--border);"></div>
          </div>

          <div style="display:flex; flex-direction:column; gap:12px;">
            ${!login ? `
            <div style="display:flex; flex-direction:column; gap:7px;">
              <span style="font-size:12px; color:var(--muted);">Nome</span>
              <input id="nameInput" data-field="name" value="${esc(s.name)}" placeholder="Como devemos te chamar" class="login-field" />
            </div>` : ""}

            <div style="display:flex; flex-direction:column; gap:7px;">
              <span style="font-size:12px; color:var(--muted);">E-mail</span>
              <input id="emailInput" data-field="email" value="${esc(s.email)}" type="email" placeholder="voce@empresa.com" class="login-field" />
            </div>

            <div style="display:flex; flex-direction:column; gap:7px;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="flex:1; font-size:12px; color:var(--muted);">Senha</span>
                ${login ? `<a href="#" style="font-size:12px; color:var(--faint); text-decoration:none;">Esqueci a senha</a>` : ""}
              </div>
              <div style="position:relative; display:flex;">
                <input id="pwInput" data-field="password" value="${esc(s.password)}" type="${s.reveal ? "text" : "password"}" placeholder="${login ? "••••••••" : "Mínimo de 8 caracteres"}" class="login-field" style="flex:1; min-width:0; padding-right:44px;" />
                <div data-action="toggle-reveal" title="Mostrar senha" style="cursor:pointer; position:absolute; right:5px; top:5px; width:30px; height:30px; border-radius:8px; display:flex; align-items:center; justify-content:center;">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.4 8S4 3.6 8 3.6 14.6 8 14.6 8 12 12.4 8 12.4 1.4 8 1.4 8z"></path><circle cx="8" cy="8" r="1.9"></circle></svg>
                </div>
              </div>
              ${!login ? `
              <div style="display:flex; flex-direction:column; gap:7px; padding-top:3px;">
                <div id="pwBars" style="display:flex; gap:5px;">
                  ${[0, 1, 2, 3].map((i) => `<div style="flex:1; height:3px; border-radius:2px; background:${barColor(i, score)};"></div>`).join("")}
                </div>
                <span id="pwLabel" style="font-size:11px; color:var(--faint);">${s.password ? "Força da senha: " + STRENGTH_LABELS[score] : "Use letras, números e um símbolo."}</span>
              </div>` : ""}
            </div>

            ${!login ? `
            <div data-action="toggle-terms" style="cursor:pointer; display:flex; align-items:flex-start; gap:9px; padding-top:2px;">
              <div id="termsBox" style="width:16px; height:16px; flex:none; margin-top:1px; border-radius:4px; border:1px solid ${s.terms ? "var(--accent)" : "var(--border-strong)"}; background:${s.terms ? "var(--accent)" : "var(--surface)"}; display:flex; align-items:center; justify-content:center;">
                <svg id="termsCheck" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--on-accent); opacity:${s.terms ? "1" : "0"};"><path d="M3.4 8.4l2.9 2.9 6.4-6.6"></path></svg>
              </div>
              <span style="font-size:12px; line-height:1.55; color:var(--muted);">Aceito os termos de uso e a política de privacidade.</span>
            </div>` : ""}

            ${s.error ? `<div id="loginError" style="border-radius:8px; border:1px solid var(--danger-border); background:var(--danger-bg); padding:10px 12px; font-size:12px; color:var(--danger);">${esc(s.error)}</div>` : ""}

            <div data-action="submit" style="cursor:pointer; height:42px; border-radius:8px; background:var(--accent); color:var(--on-accent); display:flex; align-items:center; justify-content:center; gap:8px; font-size:13px; font-weight:500; margin-top:2px; opacity:${s.loading ? "0.6" : "1"};">
              <span>${s.loading ? "Entrando…" : login ? "Entrar" : "Criar conta"}</span>
            </div>
          </div>

          <span style="font-size:12px; color:var(--faint); text-align:center;">${login ? "Ainda não tem conta?" : "Já tem uma conta?"} <a href="#" data-action="toggle-mode" style="color:var(--text); text-decoration:none; font-weight:500;">${login ? "Criar agora" : "Entrar"}</a></span>
        </div>
      </div>
    </div>
  `;
}

function bind() {
  if (bound) return;
  bound = true;

  root.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    if (action === "go-login") { state.mode = "login"; state.error = ""; render(); }
    else if (action === "go-signup") { state.mode = "signup"; state.error = ""; render(); }
    else if (action === "toggle-mode") { ev.preventDefault(); state.mode = login_opposite(); state.error = ""; render(); }
    else if (action === "toggle-reveal") {
      state.reveal = !state.reveal;
      const input = document.getElementById("pwInput") as HTMLInputElement | null;
      if (input) input.type = state.reveal ? "text" : "password";
    } else if (action === "toggle-terms") {
      state.terms = !state.terms;
      clearErrorLive();
      const box = document.getElementById("termsBox");
      const check = document.getElementById("termsCheck") as unknown as SVGElement | null;
      if (box) {
        box.style.borderColor = state.terms ? "var(--accent)" : "var(--border-strong)";
        box.style.background = state.terms ? "var(--accent)" : "var(--surface)";
      }
      if (check) (check as unknown as HTMLElement).style.opacity = state.terms ? "1" : "0";
    } else if (action === "submit") {
      submit();
    }
  });

  root.addEventListener("input", (ev) => {
    const input = ev.target as HTMLInputElement;
    const field = input.dataset.field as "name" | "email" | "password" | undefined;
    if (!field) return;
    state[field] = input.value;
    clearErrorLive();
    if (field === "password") paintStrength();
  });
}

function login_opposite(): Mode {
  return state.mode === "login" ? "signup" : "login";
}

export function mountLogin(container: HTMLElement) {
  root = container;
  bind();
  render();
}
