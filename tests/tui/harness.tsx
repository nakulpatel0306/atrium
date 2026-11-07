import { render } from "ink-testing-library";
import type { EngineClient } from "../../src/tui/client";
import { App } from "../../src/tui/components/App";
import { mouseBus } from "../../src/tui/mouse";

export const KEY = { enter: "\r", tab: "\t", shiftTab: "\x1b[Z", esc: "\x1b", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C" };

// Renders the whole app and lets a test wait for the frame it expects, without fixed sleeps.
export function openApp(client: EngineClient, size = { columns: 120, rows: 36 }) {
  const mouse = mouseBus();
  const tree = <App client={client} size={size} mouse={mouse} />;
  const r = render(tree);
  // ink-testing-library's stdout is always 100 columns wide; Ink lays out and clips to it, so match the size.
  Object.defineProperty(r.stdout, "columns", { get: () => size.columns });
  r.rerender(tree);
  const waiters = new Set<() => void>();
  const write = r.stdout.write;
  r.stdout.write = (f: string) => {
    write(f);
    for (const w of [...waiters]) w();
  };
  const frame = (pred: (f: string) => boolean, ms = 2000): Promise<string> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const f = r.lastFrame() ?? "";
        if (!pred(f)) return false;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(f);
        return true;
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`no matching frame; last frame:\n${r.lastFrame()}`));
      }, ms);
      if (!check()) waiters.add(check);
    });
  // Each write is its own read, the way a person types; Ink needs a tick between keys to process them.
  const type = async (...keys: string[]) => {
    for (const k of keys) {
      r.stdin.write(k);
      await new Promise((res) => setTimeout(res, 10));
    }
  };
  // A left click at a screen cell (0-based), then a tick for Ink to draw.
  const click = async (x: number, y: number) => {
    mouse.emit({ kind: "click", x, y });
    await new Promise((res) => setTimeout(res, 10));
  };
  const wheel = async (x: number, y: number, dir: 1 | -1) => {
    mouse.emit({ kind: "wheel", x, y, dir });
    await new Promise((res) => setTimeout(res, 10));
  };
  return { ...r, frame, type, click, wheel };
}
