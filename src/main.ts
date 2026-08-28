import "./chrome.css";
import { initRouter, navigate } from "./router";
import { mountLogin } from "./pages/login";
import { mountConsole } from "./pages/console";
import { mountEditor } from "./editor";
import { initTheme } from "./theme";

initTheme();

const views = {
  login: document.getElementById("view-login")!,
  console: document.getElementById("view-console")!,
  editor: document.getElementById("view-editor")!,
};

mountLogin(views.login);
mountConsole(views.console);

document.getElementById("backToConsole")?.addEventListener("click", () => navigate("console"));

initRouter(views, {
  editor: mountEditor,
});

window.addEventListener("blank-editor-saved", () => {
  const st = document.getElementById("saveStatus");
  if (!st) return;
  st.textContent = "Salvo";
  st.dataset.state = "saved";
});

function fillTemplateThumbs(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".tplcard[data-id]").forEach((card) => {
    const id = card.dataset.id;
    const thumb = card.querySelector(".tplcard-thumb");
    if (!id || !thumb || thumb.querySelector("img")) return;
    const img = document.createElement("img");
    img.alt = "";
    img.src = `/api/v1/templates/${encodeURIComponent(id)}/cover`;
    img.addEventListener("error", () => img.setAttribute("data-broken", "1"));
    thumb.replaceChildren(img);
  });
}

const consoleRoot = document.getElementById("view-console");
if (consoleRoot) {
  fillTemplateThumbs(consoleRoot);
  new MutationObserver(() => fillTemplateThumbs(consoleRoot)).observe(consoleRoot, {
    childList: true,
    subtree: true,
  });
}

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
  const unscale = Math.min(1 / Math.max(z, 0.18), 2.8);
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
