// The site's Plum (site/plum.js): the still image is Plum until the live one draws, and stays Plum without WebGL.
import { openDom } from "./dom";
import { expect, jest, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOP_SECONDS, hopper, mountPlum, POSES, stillSrc } from "../../site/plum.js";

openDom();

const host = (pose: string) => {
  const el = document.createElement("div");
  el.className = "plum";
  el.innerHTML = `<img class="plum-still" alt="" src="${stillSrc(pose)}">`;
  return el;
};
const img = (el: HTMLElement) => el.querySelector("img")!.getAttribute("src")!;

test("there is a still for every pose", () => {
  expect(POSES).toEqual(["brief", "work", "checks", "ready", "look", "quiet"]);
  for (const p of POSES) expect(existsSync(fileURLToPath(stillSrc(p)))).toBe(true);
});

test("when three.js can't load, set() swaps the still, and an unknown pose changes nothing", async () => {
  const el = host("work");
  const plum = mountPlum(el, { pose: "work", still: true, load: () => Promise.reject(new Error("offline")) });
  await plum.ready;
  expect(plum.live).toBe(false);
  expect(el.classList.contains("plum-live")).toBe(false);
  plum.set("look");
  expect(plum.pose).toBe("look");
  expect(img(el)).toEndWith("plum/look.webp");
  plum.set("dance");
  expect(plum.pose).toBe("look");
});

test("when the browser can't draw WebGL, Plum stays the still image", async () => {
  const el = host("quiet");
  const fake = {
    WebGLRenderer: class {
      constructor() {
        throw new Error("no WebGL");
      }
    },
  };
  let live = false;
  const plum = mountPlum(el, { pose: "quiet", still: true, load: async () => fake, onLive: () => (live = true) });
  await plum.ready;
  expect(live).toBe(false);
  expect(plum.live).toBe(false);
  expect(el.querySelector("canvas")).toBeNull();
  plum.set("ready");
  expect(img(el)).toEndWith("plum/ready.webp");
});

test("a pose that isn't one of the six starts as quiet", async () => {
  const plum = mountPlum(host("quiet"), { pose: "nope", still: true, load: () => Promise.reject(new Error("x")) });
  await plum.ready;
  expect(plum.pose).toBe("quiet");
});

test("a browser that can't draw WebGL never downloads three.js", async () => {
  const before = document.querySelectorAll("script").length;
  const el = host("look");
  const plum = mountPlum(el, { pose: "look", still: true });
  await plum.ready;
  expect(plum.live).toBe(false);
  expect(String(plum.error)).toContain("can't draw WebGL");
  expect(document.querySelectorAll("script").length).toBe(before);
  expect(img(el)).toEndWith("plum/look.webp");
});

test("the hop clock fires once as each hop starts, and not for a hop already under way", () => {
  const hop = hopper();
  expect(hop(0)).toBe(true);
  expect(hop(0.3)).toBe(false);
  expect(hop(1.79)).toBe(false);
  expect(hop(HOP_SECONDS + 0.02)).toBe(true);
  expect(hop(HOP_SECONDS + 0.5)).toBe(false);
  // Coming back on screen in the middle of a hop isn't the start of one.
  const late = hopper();
  expect(late(HOP_SECONDS * 3 + 1)).toBe(false);
  expect(late(HOP_SECONDS * 4 + 0.01)).toBe(true);
});

test("with the still image, onHop keeps the hop's cadence while the pose is ready, and stops with destroy", async () => {
  jest.useFakeTimers();
  try {
    let hops = 0;
    const plum = mountPlum(host("ready"), { pose: "ready", still: false, load: () => Promise.reject(new Error("x")), onHop: () => hops++ });
    await plum.ready;
    jest.advanceTimersByTime(HOP_SECONDS * 1000 * 2 + 100);
    expect(hops).toBe(2);
    plum.set("quiet");
    jest.advanceTimersByTime(HOP_SECONDS * 1000 * 2);
    expect(hops).toBe(2);
    plum.set("ready");
    jest.advanceTimersByTime(HOP_SECONDS * 1000);
    expect(hops).toBe(3);
    plum.destroy();
    jest.advanceTimersByTime(HOP_SECONDS * 1000 * 3);
    expect(hops).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});

test("a Plum held still never hops, so onHop never fires", async () => {
  jest.useFakeTimers();
  try {
    let hops = 0;
    const plum = mountPlum(host("ready"), { pose: "ready", still: true, load: () => Promise.reject(new Error("x")), onHop: () => hops++ });
    await plum.ready;
    jest.advanceTimersByTime(HOP_SECONDS * 1000 * 4);
    expect(hops).toBe(0);
    plum.destroy();
  } finally {
    jest.useRealTimers();
  }
});

test("with hopOnClick, Plum never hops by itself; a click or Enter/Space on it fires onHop once each", async () => {
  jest.useFakeTimers();
  try {
    let hops = 0;
    const el = host("ready");
    const plum = mountPlum(el, { pose: "ready", still: false, hopOnClick: true, load: () => Promise.reject(new Error("x")), onHop: () => hops++ });
    await plum.ready;
    jest.advanceTimersByTime(HOP_SECONDS * 1000 * 4);
    expect(hops).toBe(0);
    el.click();
    expect(hops).toBe(1);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(hops).toBe(3);
    plum.destroy();
    el.click();
    expect(hops).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});

test("with hopOnClick, a Plum held still or in another pose doesn't hop on a click", async () => {
  let hops = 0;
  const held = host("ready");
  const a = mountPlum(held, { pose: "ready", still: true, hopOnClick: true, load: () => Promise.reject(new Error("x")), onHop: () => hops++ });
  await a.ready;
  held.click();
  const other = host("quiet");
  const b = mountPlum(other, { pose: "quiet", still: false, hopOnClick: true, load: () => Promise.reject(new Error("x")), onHop: () => hops++ });
  await b.ready;
  other.click();
  expect(hops).toBe(0);
  a.destroy();
  b.destroy();
});
