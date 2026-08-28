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
