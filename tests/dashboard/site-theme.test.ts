// The site's theme switch (site/theme.js): match the Mac, light or dark, kept per browser, set before first paint.
import { openDom } from "./dom";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyTheme, KEY, NO_FLASH, storedTheme, wireThemeSwitch } from "../../site/theme.js";

openDom();

const SITE = join(import.meta.dir, "..", "..", "site");

// The site's functions take the browser's Storage; these stand-ins have only the three methods they call.
class MemoryStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}
const memory = () => new MemoryStore() as unknown as Storage;
const broken = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
} as unknown as Storage;

test("a stored light or dark wins; anything else follows the Mac", () => {
  const s = memory();
  expect(storedTheme(s)).toBe("system");
  s.setItem(KEY, "dark");
  expect(storedTheme(s)).toBe("dark");
  s.setItem(KEY, "purple");
  expect(storedTheme(s)).toBe("system");
  expect(storedTheme(broken)).toBe("system");
});

test("picking a theme sets the page and remembers it; system forgets it", () => {
  const s = memory();
  const root = document.createElement("html");
  applyTheme("light", root, s);
  expect(root.dataset.theme).toBe("light");
  expect(s.getItem(KEY)).toBe("light");
  applyTheme("system", root, s);
  expect(root.dataset.theme).toBeUndefined();
  expect(s.getItem(KEY)).toBeNull();
  // A browser that keeps nothing still switches for this visit.
  applyTheme("dark", root, broken);
  expect(root.dataset.theme).toBe("dark");
});

test("the switch shows the current choice, and a click or an arrow key changes it", () => {
  const s = memory();
  s.setItem(KEY, "dark");
  const root = document.createElement("html");
  const group = document.createElement("div");
  group.innerHTML = ["system", "light", "dark"].map((t) => `<button type="button" role="radio" data-theme-set="${t}"></button>`).join("");
  wireThemeSwitch(group, root, s);
  const [sys, light, dark] = [...group.querySelectorAll("button")] as HTMLButtonElement[];
  const checked = () => [sys, light, dark].map((b) => b!.getAttribute("aria-checked"));
  expect(checked()).toEqual(["false", "false", "true"]);
  expect([sys, light, dark].map((b) => b!.tabIndex)).toEqual([-1, -1, 0]);
  light!.click();
  expect(root.dataset.theme).toBe("light");
  expect(checked()).toEqual(["false", "true", "false"]);
  light!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(root.dataset.theme).toBeUndefined();
  expect(checked()).toEqual(["true", "false", "false"]);
  sys!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(checked()).toEqual(["false", "false", "true"]);
});

test("every page sets the stored theme in its head before any stylesheet, so nothing flashes", () => {
  const pages = readdirSync(SITE).filter((f) => f.endsWith(".html"));
  expect(pages.length).toBeGreaterThan(10);
  for (const page of pages) {
    const html = readFileSync(join(SITE, page), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    const at = head.indexOf(`<script>${NO_FLASH}</script>`);
    expect({ page, at: at >= 0 }).toEqual({ page, at: true });
    expect({ page, beforeCss: at < head.indexOf("<link rel=\"stylesheet\"") }).toEqual({ page, beforeCss: true });
    expect({ page, switch: html.includes("data-theme-switch") }).toEqual({ page, switch: true });
  }
});

test("the head script picks up what the switch stored", () => {
  const s = memory();
  applyTheme("light", document.createElement("html"), s);
  const root = document.createElement("html");
  new Function("localStorage", "document", NO_FLASH)(s, { documentElement: root });
  expect(root.dataset.theme).toBe("light");
});
