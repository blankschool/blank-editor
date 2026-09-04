/**
 * Three routes share one page: login, console, editor. Each view is a plain
 * div toggled by display; nothing unmounts. onShow fires every time a route
 * activates — each page module decides internally whether that means "mount
 * once" or "also refresh". The editor needs this repeated-call: its zoomFit
 * reads the stage's bounding box, which is only meaningful once the
 * container is actually visible (display:none reports a 0x0 rect).
 */
import { getSessionStatus, hasSession, onSessionChange } from "./session";

export type Route = "login" | "console" | "editor" | "p";

const ROUTES: Route[] = ["login", "console", "editor", "p"];
// Bare/unknown hash defaults to console — but the gate below gets the final say:
// an unauthenticated visitor lands on login regardless, and this default only
// matters for someone who's already signed in.
const DEFAULT_ROUTE: Route = "console";

/**
 * console and editor require a session; login never does — showing it to
 * someone already signed in is harmless, unlike hiding it from someone who
 * isn't.
 */
function requiresSession(route: Route): boolean {
  return route === "console" || route === "editor";
}

export function navigate(route: Route) {
  location.hash = "/" + route;
}

export function initRouter(views: Record<Route, HTMLElement>, onShow: Partial<Record<Route, () => void>>) {
  function requestedRoute(): Route {
    // Only the first path segment identifies the top-level route — a page can have its own
    // sub-routes after that (e.g. "#/console/keys"), which this router doesn't need to know about.
    const first = location.hash.replace(/^#\/?/, "").split("/")[0] as Route;
    return ROUTES.includes(first) ? first : DEFAULT_ROUTE;
  }

  const loadingView = document.getElementById("view-loading");

  function apply() {
    // A sessão resolve de forma assíncrona agora (cookie httpOnly, verificado contra o
    // servidor) — enquanto isso não resolveu ao menos uma vez, nem login nem console/editor
    // aparecem, senão quem já está logado veria a tela de login piscar a cada refresh.
    if (getSessionStatus() === "loading") {
      for (const r of ROUTES) views[r].style.display = "none";
      return;
    }
    if (loadingView) loadingView.style.display = "none";

    const requested = requestedRoute();
    const route = requiresSession(requested) && !hasSession() ? "login" : requested;
    // Rewrites the address bar to match what's actually on screen — the same
    // reasoning as the console's own hash canonicalisation: a URL claiming
    // #/editor/xyz while the login screen shows would confuse refresh, back,
    // and anyone reading the bar to see what page they're on.
    if (route !== requested) history.replaceState(null, "", "#/login");
    for (const r of ROUTES) views[r].style.display = r === route ? "" : "none";
    onShow[route]?.();
  }

  window.addEventListener("hashchange", apply);
  onSessionChange(apply);
  apply();
}
