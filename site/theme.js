// The site's theme: match the Mac (the default), light or dark, remembered per browser. The same key and the same
// three choices as the dashboard (src/dashboard/theme.ts).
export const KEY = "atrium.theme";
const THEMES = ["system", "light", "dark"];

// Every page runs this in its <head>, before its stylesheet, so a stored theme is set before the first paint.
export const NO_FLASH = `try{var t=localStorage.getItem("atrium.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function storedTheme(storage = globalThis.localStorage) {
  try {
    const v = storage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme, root = document.documentElement, storage = globalThis.localStorage) {
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") storage.removeItem(KEY);
    else storage.setItem(KEY, theme);
  } catch {
    // A browser that keeps no storage still switches for this visit.
  }
}

// A radio group of three buttons (data-theme-set="system|light|dark"): click to pick, arrow keys to move.
export function wireThemeSwitch(group, root = document.documentElement, storage = globalThis.localStorage) {
  const buttons = [...group.querySelectorAll("[data-theme-set]")];
  const show = (theme) =>
    buttons.forEach((b) => {
      const on = b.dataset.themeSet === theme;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  const pick = (theme, focus) => {
    applyTheme(theme, root, storage);
    show(theme);
    if (focus) buttons.find((b) => b.dataset.themeSet === theme)?.focus();
  };
  buttons.forEach((b) => {
    b.addEventListener("click", () => pick(b.dataset.themeSet, false));
    b.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const i = THEMES.indexOf(b.dataset.themeSet);
      pick(THEMES[(i + step + THEMES.length) % THEMES.length], true);
    });
  });
  show(storedTheme(storage));
}

if (typeof document !== "undefined") document.querySelectorAll("[data-theme-switch]").forEach((g) => wireThemeSwitch(g));
