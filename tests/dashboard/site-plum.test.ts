// The site's Plum (site/plum.js): the still image is Plum until the live one draws, and stays Plum without WebGL.
import { openDom } from "./dom";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mountPlum, POSES, stillSrc } from "../../site/plum.js";

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
