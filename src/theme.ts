/**
 * UI theme: light / dark / system. "system" means no explicit override —
 * styles.css already defines the system look via prefers-color-scheme, so
 * that mode just means "no data-theme attribute at all".
 */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "blank-editor-theme";

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* blocked storage */ }
  return "system";
}

export function setTheme(choice: ThemeChoice) {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
    try { localStorage.removeItem(KEY); } catch { /* blocked storage */ }
    return;
  }
  document.documentElement.setAttribute("data-theme", choice);
  try { localStorage.setItem(KEY, choice); } catch { /* blocked storage */ }
}

export function initTheme() {
  const choice = getTheme();
  if (choice !== "system") document.documentElement.setAttribute("data-theme", choice);
}
