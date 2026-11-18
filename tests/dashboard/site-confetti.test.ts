// The landing page's confetti (site/confetti.js): bursts from Plum, falls and fades, and never shows with reduced motion.
import { openDom } from "./dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { advance, alphaOf, burstPieces, MAX_PIECES, mountConfetti, PER_BURST } from "../../site/confetti.js";

openDom();

// A seeded stand-in for Math.random, so a burst is the same every run.
const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// happy-dom has no 2D canvas; this one takes every call the confetti makes and draws nothing.
const ctx = new Proxy({}, { get: () => () => {} });
const realGetContext = HTMLCanvasElement.prototype.getContext;
const realIO = globalThis.IntersectionObserver;
let seen: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof realGetContext;
  seen = [];
  globalThis.IntersectionObserver = class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      seen.push(cb);
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  globalThis.IntersectionObserver = realIO;
});

// The reduced-motion query, with only what the confetti reads, and a way to flip it as the setting would.
const query = (matches: boolean) => {
  const listeners: (() => void)[] = [];
  const q = {
    matches,
    addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
    removeEventListener() {},
    change(next: boolean) {
      q.matches = next;
      for (const fn of listeners) fn();
    },
  };
  return q as typeof q & MediaQueryList;
};
const section = () => {
  const host = document.createElement("section");
  const plum = document.createElement("div");
  host.append(plum);
  document.body.append(host);
  return { host, plum };
};

test("a burst throws its pieces up from where it starts", () => {
  const pieces = burstPieces(PER_BURST, 200, 300, 1, ["#9b84ff", "#e8c46a"], seeded());
  expect(pieces).toHaveLength(PER_BURST);
  for (const p of pieces) {
    expect(p.y).toBe(300);
    expect(Math.abs(p.x - 200)).toBeLessThanOrEqual(60);
    expect(p.vy).toBeLessThan(0);
    expect(["#9b84ff", "#e8c46a"]).toContain(p.color);
  }
});

test("pieces fall back under gravity, fade out, and are all gone within a few seconds", () => {
  let pieces = burstPieces(PER_BURST, 200, 300, 1, ["#9b84ff"], seeded());
  const [first] = pieces;
  for (let i = 0; i < 30; i++) pieces = advance(pieces, 1 / 60, 400, 600);
  expect(first!.y).toBeLessThan(300);
  const rising = first!.vy;
  for (let i = 0; i < 30; i++) pieces = advance(pieces, 1 / 60, 400, 600);
  expect(first!.vy).toBeGreaterThan(rising);
  expect(alphaOf({ ...first!, age: 0 })).toBe(1);
  expect(alphaOf({ ...first!, age: first!.life })).toBe(0);
  for (let i = 0; i < 60 * 3; i++) pieces = advance(pieces, 1 / 60, 400, 600);
  expect(pieces).toEqual([]);
});

test("a piece that leaves the canvas is dropped at once", () => {
  const [p] = burstPieces(1, 200, 300, 1, ["#9b84ff"], seeded());
  expect(advance([{ ...p!, y: 700 }], 1 / 60, 400, 600)).toEqual([]);
  expect(advance([{ ...p!, x: -100 }], 1 / 60, 400, 600)).toEqual([]);
});

test("with reduced motion there's no confetti at all: no canvas, no pieces", () => {
  const { host, plum } = section();
  const c = mountConfetti(host, { from: plum, motion: query(true) });
  c.burst();
  c.burst();
  expect(c.count).toBe(0);
  expect(host.querySelector("canvas")).toBeNull();
  c.destroy();
});

test("a hop adds a burst on a canvas that can't be clicked, and the pieces in the air stay capped", () => {
  const { host, plum } = section();
  const c = mountConfetti(host, { from: plum, motion: query(false) });
  c.burst();
  const canvas = host.querySelector("canvas")!;
  expect(canvas.style.pointerEvents).toBe("none");
  expect(canvas.getAttribute("aria-hidden")).toBe("true");
  expect(c.count).toBe(PER_BURST);
  for (let i = 0; i < 10; i++) c.burst();
  expect(c.count).toBe(MAX_PIECES);
  expect(host.querySelectorAll("canvas")).toHaveLength(1);
  c.destroy();
  expect(host.querySelector("canvas")).toBeNull();
});

test("turning reduced motion on clears what's in the air, and later hops add nothing", () => {
  const { host, plum } = section();
  const motion = query(false);
  const c = mountConfetti(host, { from: plum, motion });
  c.burst();
  expect(c.count).toBe(PER_BURST);
  motion.change(true);
  expect(c.count).toBe(0);
  c.burst();
  expect(c.count).toBe(0);
  c.destroy();
});

test("off screen, the pieces are cleared and a hop adds none until the section is back", () => {
  const { host, plum } = section();
  const c = mountConfetti(host, { from: plum, motion: query(false) });
  c.burst();
  seen.at(-1)!([{ isIntersecting: true }, { isIntersecting: false }]);
  expect(c.count).toBe(0);
  c.burst();
  expect(c.count).toBe(0);
  // A jump to the section can report leaving and arriving together; the last entry is where it is now.
  seen.at(-1)!([{ isIntersecting: false }, { isIntersecting: true }]);
  c.burst();
  expect(c.count).toBe(PER_BURST);
  c.destroy();
});

test("a browser with no 2D canvas gets no confetti, and later hops still add nothing and don't throw", () => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof realGetContext;
  const { host, plum } = section();
  const c = mountConfetti(host, { from: plum, motion: query(false) });
  c.burst();
  expect(() => c.burst()).not.toThrow();
  expect(c.count).toBe(0);
  expect(host.querySelector("canvas")).toBeNull();
  c.destroy();
});
