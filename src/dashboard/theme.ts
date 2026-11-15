import type { Theme } from "./palette";

// Light, dark, or the Mac's own setting, kept per browser: it's a viewer's preference, not the engine's.
const KEY = "atrium.theme";

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // A browser that keeps no storage still switches for this visit.
  }
}
