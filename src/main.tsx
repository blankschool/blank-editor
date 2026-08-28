// Ordem dos CSS importa e é deliberada:
//   1. app.css  — tema e utilitários do Tailwind. Vem primeiro para que, num
//      empate de especificidade, o CSS legado ainda vença (ver o comentário
//      longo em app.css sobre por que nada disso está em @layer).
//   2. chrome.css antes de styles.css — a mesma ordem de sempre. chrome.css
//      sobrescreve styles.css por especificidade, não por posição, mas inverter
//      isso é risco sem ganho.
//   3. styles.css entra aqui explicitamente. Antes ele chegava de carona no
//      `import "./styles.css"` do editor.ts, o que fazia o console depender do
//      editor para ter estilo — acoplamento acidental, e frágil.
import "./app.css";
import "./chrome.css";
import "./styles.css";

import { createRoot } from "react-dom/client";
import { initRouter, navigate } from "./router";
import { mountEditor } from "./editor";
import { initTheme } from "./theme";
import { ConsoleApp } from "./console/ConsoleApp";
import { openConsole } from "./console/store";
import { LoginApp } from "./login/LoginApp";

initTheme();

const views = {
  login: document.getElementById("view-login")!,
  console: document.getElementById("view-console")!,
  editor: document.getElementById("view-editor")!,
};

// Login e console são React; o editor segue sendo DOM imperativo montado por
// mountEditor() sobre o markup fixo do index.html. As três views convivem no
// mesmo documento e o router alterna `display` — nenhuma desmonta, e é por isso
// que o estado do console sobrevive a uma ida e volta ao editor.
createRoot(views.login).render(<LoginApp />);
createRoot(views.console).render(<ConsoleApp />);

document.getElementById("backToConsole")?.addEventListener("click", () => navigate("console"));

initRouter(views, {
  editor: mountEditor,
  // O console revalida ao reaparecer: voltar do editor tem que mostrar o design
  // que você acabou de criar ou renomear em "Seus designs".
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
  // Capped at 1.8, not 2.8: the page chrome lives inside the PAGE_GAP (96 world px in
  // editor.ts) and the tallest piece is the 44px add-page button, so 44 * 1.8 = 79 is the
  // most that still fits with breathing room. Past that the chrome would overlap the pages,
  // so below ~56% zoom it shrinks with the page instead.
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
