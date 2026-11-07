// Mouse support Ink doesn't have: SGR mouse reports (ESC[<b;x;yM) are taken out of stdin before Ink sees it, and
// everything else (keys, escapes, bracketed paste) is passed on byte for byte.
import { Readable } from "node:stream";

// Button presses and releases (1000) in SGR form (1006), which has no column limit and can't be mistaken for text.
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

// x and y are 0-based screen cells.
export type MouseEvent = { kind: "click"; x: number; y: number } | { kind: "wheel"; x: number; y: number; dir: 1 | -1 };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const REPORT = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const PARTIAL = /^\x1b\[<[\d;]*$/;

function eventOf(button: number, x: number, y: number, press: boolean): MouseEvent | null {
  // Bit 6 marks the wheel; the low bits say which way. Motion (bit 5) and modifiers are ignored.
  if (button & 64) return press ? { kind: "wheel", x: x - 1, y: y - 1, dir: (button & 1) === 1 ? 1 : -1 } : null;
  if ((button & 3) === 0 && !(button & 32) && press) return { kind: "click", x: x - 1, y: y - 1 };
  return null;
}

// A lone ESC or ESC[ at the end of a read might be the start of a report cut in two, or an Esc press. It's held this
// long for the rest; if nothing comes, it goes on to Ink, so Esc is barely delayed.
export const ESC_HOLD_MS = 25;

// Splits each chunk into mouse events and the text Ink should get. A report cut across two chunks is held until its
// end arrives; inside a bracketed paste nothing is touched. `flush` gets a held ESC or ESC[ that turned out to be keys.
export function mouseFilter(onMouse: (e: MouseEvent) => void, flush?: (text: string) => void): (chunk: string) => string {
  let held = "";
  let pasting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (chunk) => {
    if (timer) clearTimeout(timer);
    timer = null;
    let s = held + chunk;
    held = "";
    let out = "";
    while (s.length) {
      if (pasting) {
        const end = s.indexOf(PASTE_END);
        if (end < 0) {
          out += s;
          break;
        }
        out += s.slice(0, end + PASTE_END.length);
        s = s.slice(end + PASTE_END.length);
        pasting = false;
        continue;
      }
      const at = s.indexOf("\x1b");
      if (at < 0) {
        out += s;
        break;
      }
      out += s.slice(0, at);
      s = s.slice(at);
      if (s.startsWith(PASTE_START)) {
        pasting = true;
        out += PASTE_START;
        s = s.slice(PASTE_START.length);
        continue;
      }
      const m = REPORT.exec(s);
      if (m) {
        const e = eventOf(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "M");
        if (e) onMouse(e);
        s = s.slice(m[0].length);
        continue;
      }
      if (PARTIAL.test(s) && s.length > 2) {
        held = s;
        break;
      }
      if (s === "\x1b" || s === "\x1b[") {
        held = s;
        if (flush) {
          timer = setTimeout(() => {
            timer = null;
            const text = held;
            held = "";
            if (text) flush(text);
          }, ESC_HOLD_MS);
        }
        break;
      }
      out += "\x1b";
      s = s.slice(1);
    }
    return out;
  };
}

type RawStream = NodeJS.ReadStream & { setRawMode(mode: boolean): unknown };

// A stand-in stdin for Ink: raw mode and ref counting go to the real one, and only filtered text comes out.
export function filteredStdin(real: RawStream, onMouse: (e: MouseEvent) => void): NodeJS.ReadStream {
  const proxy = new Readable({ read() {} }) as Readable & { isTTY: boolean; setRawMode(m: boolean): unknown; ref(): unknown; unref(): unknown };
  const filter = mouseFilter(onMouse, (text) => proxy.push(text));
  let listening = false;
  const onData = (chunk: string | Buffer) => {
    const text = filter(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    if (text) proxy.push(text);
  };
  proxy.isTTY = true;
  proxy.setRawMode = (mode: boolean) => {
    real.setRawMode(mode);
    if (mode && !listening) {
      listening = true;
      real.setEncoding("utf8");
      real.on("data", onData);
    } else if (!mode && listening) {
      listening = false;
      real.off("data", onData);
      real.pause();
    }
    return proxy;
  };
  proxy.ref = () => {
    real.ref();
    return proxy;
  };
  proxy.unref = () => {
    real.unref();
    return proxy;
  };
  return proxy as unknown as NodeJS.ReadStream;
}

// Where clicks reach the app: main feeds it from stdin, tests call emit.
export type MouseBus = { subscribe(fn: (e: MouseEvent) => void): () => void; emit(e: MouseEvent): void };

export function mouseBus(): MouseBus {
  const fns = new Set<(e: MouseEvent) => void>();
  return {
    subscribe(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    emit(e) {
      for (const fn of [...fns]) fn(e);
    },
  };
}
