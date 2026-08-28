// Ordem dos CSS importa e é deliberada:
//   1. app.css  — tema e utilitários do Tailwind.
//   2. styles.css — chrome legado do editor.
//   3. chrome.css DEPOIS — régua visível (40px / 14px). Em empate, o último arquivo vence.
import "./app.css";
import "./styles.css";
import "./chrome.css";

import { createRoot } from "react-dom/client";
import { initRouter, navigate } from "./router";
import { mountEditor } from "./editor";
import { initTheme } from "./theme";
import { ConsoleApp } from "./console/ConsoleApp";
import { openConsole } from "./console/store";
import { LoginApp } from "./login/LoginApp";
import { bootSession } from "./session";

initTheme();
// Assíncrono de propósito: a sessão vive num cookie httpOnly, então só o servidor sabe dizer
// quem está logado. initRouter já reage sozinho quando isto resolve (router.ts assina
// onSessionChange) — não precisa aguardar aqui antes de montar o resto do app.
void bootSession();

const views = {
  login: document.getElementById("view-login")!,
  console: document.getElementById("view-console")!,
  editor: document.getElementById("view-editor")!,
};

createRoot(views.login).render(<LoginApp />);
createRoot(views.console).render(<ConsoleApp />);

document.getElementById("backToConsole")?.addEventListener("click", () => navigate("console"));

initRouter(views, {
  editor: mountEditor,
  console: openConsole,
});

window.addEventListener("blank-editor-saved", () => {
  const st = document.getElementById("saveStatus");
  if (!st) return;
  st.textContent = "Salvo";
  st.dataset.state = "saved";
});

function worldZoom(): number {
  const el = document.getElementById("world");
  if (!el) return 1;
  const m = /scale\(([-0-9.]+)\)/.exec(el.style.transform || "");
  if (m) return Number(m[1]) || 1;
  const css = getComputedStyle(el).transform;
  if (css && css !== "none") {
    const nums = css.match(/matrix\(([^)]+)\)/);
    if (nums) return Math.abs(Number(nums[1].split(",")[0])) || 1;
  }
  return 1;
}

function unscalePageChrome() {
  const z = worldZoom();
  const unscale = Math.min(1 / Math.max(z, 0.18), 1.8);
  document.documentElement.style.setProperty("--page-unscale", unscale.toFixed(3));
}

const world = document.getElementById("world");
if (world) {
  new MutationObserver(unscalePageChrome).observe(world, { attributes: true, attributeFilter: ["style"] });
}
document.getElementById("stage")?.addEventListener("wheel", unscalePageChrome, { passive: true });
window.addEventListener("resize", unscalePageChrome);
unscalePageChrome();
requestAnimationFrame(unscalePageChrome);
