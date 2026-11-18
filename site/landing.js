// The landing page's motion: the hero's one entrance, the loop told on scroll, and Plum reacting to the demo.
// With reduced motion on, every Plum holds its pose, the ask shows in full, and scrolling only changes the pose.
import { mountPlum } from "./plum.js";

const $ = (id) => document.getElementById(id);
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The loop's steps and the pose Plum takes for each.
const LOOP = ["brief", "work", "checks", "look", "ready"];

// Hero: the ask types itself, is sent, and the loop lights up step by step while Plum acts each one out.
const hero = mountPlum($("hero-plum"), { pose: "work", interactive: true });
async function heroMoment() {
  const typed = $("typed"), go = $("go"), flow = [...$("flow").children];
  if (still) return;
  const phrase = typed.textContent;
  typed.textContent = "";
  await wait(1000);
  for (const ch of phrase) {
    typed.textContent += ch;
    await wait(42);
  }
  await wait(380);
  go.classList.add("pressed");
  await wait(180);
  go.classList.remove("pressed");
  for (let i = 0; i < LOOP.length; i++) {
    flow.forEach((li, j) => li.classList.toggle("on", j === i));
    hero.set(LOOP[i]);
    await wait(1150);
  }
  await wait(1800);
  flow.forEach((li) => li.classList.remove("on"));
  hero.set("work");
}
heroMoment();

// The story: the step nearest the middle of the screen sets Plum's pose and the step list beside it.
const story = mountPlum($("story-plum"), { pose: "brief", lazy: true });
const beats = [...document.querySelectorAll(".beat")];
const now = [...$("now").children];
let active = -1;
function follow() {
  const line = innerHeight * 0.55;
  let i = 0;
  beats.forEach((b, j) => {
    if (b.getBoundingClientRect().top < line) i = j;
  });
  if (i === active) return;
  active = i;
  story.set(beats[i].dataset.pose);
  now.forEach((li, j) => li.classList.toggle("on", j === i));
}
addEventListener("scroll", follow, { passive: true });
addEventListener("resize", follow);
follow();

// The demo: Plum looks up when something is ready, works while a task runs, waves at a yes, and dozes off after.
const tryPlum = mountPlum($("try-plum"), { pose: "quiet", lazy: true });
let settle;
addEventListener("atrium:demo", (e) => {
  const t = e.detail || "";
  let pose = null;
  if (/^Ready for review/.test(t)) pose = "look";
  else if (/started|Set up|Sent back|Note sent/.test(t)) pose = "work";
  else if (/^Pushed|^Kept/.test(t)) pose = "ready";
  if (!pose) return;
  tryPlum.set(pose);
  clearTimeout(settle);
  settle = setTimeout(() => tryPlum.set("quiet"), pose === "work" ? 12000 : 5000);
});
