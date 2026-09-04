// Ordem dos CSS importa e é deliberada:
//   1. app.css  — tema e utilitários do Tailwind.
//   2. styles.css — chrome legado do editor.
//   3. chrome.css — layout responsivo e controles do editor em pixels de tela.
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
import { PublicView } from "./public/PublicView";
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
  p: document.getElementById("view-p")!,
};

createRoot(views.login).render(<LoginApp />);
createRoot(views.console).render(<ConsoleApp />);
createRoot(views.p).render(<PublicView />);

document.getElementById("backToConsole")?.addEventListener("click", () => navigate("console"));

initRouter(views, {
  editor: mountEditor,
  console: openConsole,
});
