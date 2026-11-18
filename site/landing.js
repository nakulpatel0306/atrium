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
  typed.dataset.phrase = phrase;
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
    flow.forEach((li, j) => {
      li.classList.toggle("on", j === i);
      li.toggleAttribute("aria-current", j === i);
    });
    hero.set(LOOP[i]);
    await wait(1150);
  }
  await wait(1800);
  flow.forEach((li) => {
    li.classList.remove("on");
    li.removeAttribute("aria-current");
  });
  hero.set("work");
}
heroMoment();

// The ask in the hero is the demo's ask: a click opens the matching space in the working copy of the app, with the
// line in its ask bar, ready to send.
$("hero-ask").addEventListener("click", (e) => {
  if (!$("m-ask")) return;
  e.preventDefault();
  dispatchEvent(new CustomEvent("atrium:ask", { detail: { space: "web", text: $("typed").dataset.phrase || $("typed").textContent } }));
  $("m-ask").focus({ preventScroll: true });
  // The demo's window ends at the foot of the screen, so the ask bar holding the line is in view. A smooth scroll can
  // be cut short while the page is still loading, so it's checked once it should have landed and finished if not.
  const land = () => $("mac").scrollIntoView({ behavior: still ? "auto" : "smooth", block: "end" });
  land();
  setTimeout(() => {
    const r = $("m-ask").getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) land();
  }, still ? 0 : 1200);
});

// The story: the step crossing the middle of what's visible sets Plum's pose and the step list beside it. That's the
// middle below the bar, where Plum is held, or below Plum's strip when the story is one column.
const story = mountPlum($("story-plum"), { pose: "brief", lazy: true });
const beats = [...document.querySelectorAll(".beat")];
const now = [...$("now").children];
const side = document.querySelector(".story-side");
// Matches the one-column story rule in index.html.
const oneColumn = matchMedia("(max-width: 860px)");
let active = -1;
function follow() {
  const strip = oneColumn.matches;
  const top = (strip ? side : $("bar")).getBoundingClientRect().bottom;
  const line = (top + innerHeight) / 2;
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

// Privacy: Plum stands in its checks ring, the sandbox drawn as a fence it scans up and down.
mountPlum($("private-plum"), { pose: "checks", lazy: true });

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
