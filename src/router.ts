/**
 * Three routes share one page: login, console, editor. Each view is a plain
 * div toggled by display; nothing unmounts. onShow fires every time a route
 * activates — each page module decides internally whether that means "mount
 * once" or "also refresh". The editor needs this repeated-call: its zoomFit
 * reads the stage's bounding box, which is only meaningful once the
 * container is actually visible (display:none reports a 0x0 rect).
 */
export type Route = "login" | "console" | "editor";

const ROUTES: Route[] = ["login", "console", "editor"];
// Login has no real auth behind it yet — disabled for now, so the app boots straight into the
// console instead of a screen that doesn't actually gate anything.
const DEFAULT_ROUTE: Route = "console";

export function navigate(route: Route) {
  location.hash = "/" + route;
}

export function initRouter(views: Record<Route, HTMLElement>, onShow: Partial<Record<Route, () => void>>) {
  function current(): Route {
    // Only the first path segment identifies the top-level route — a page can have its own
    // sub-routes after that (e.g. "#/console/keys"), which this router doesn't need to know about.
    const first = location.hash.replace(/^#\/?/, "").split("/")[0] as Route;
    if (first === "login") return DEFAULT_ROUTE;
    return ROUTES.includes(first) ? first : DEFAULT_ROUTE;
  }

  function apply() {
    const route = current();
    for (const r of ROUTES) views[r].style.display = r === route ? "" : "none";
    onShow[route]?.();
  }

  window.addEventListener("hashchange", apply);
  apply();
}
