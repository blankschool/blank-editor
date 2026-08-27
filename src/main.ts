import { initRouter, navigate } from "./router";
import { mountLogin } from "./pages/login";
import { mountConsole } from "./pages/console";
import { mountEditor } from "./editor";

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
