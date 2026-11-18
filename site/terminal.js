// The terminal page: tabs between the app's screens, and Plum taking the pose that fits each one. With focus inside the
// window, the keys printed on the tabs (1, ?, space, 2) switch screens as they do in the app.
import { mountPlum } from "./plum.js";

const plum = mountPlum(document.getElementById("term-plum"), { pose: "look", interactive: true });
const tabs = [...document.querySelectorAll(".screens [role=tab]")];

function pick(tab, focus) {
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  });
  plum.set(tab.dataset.pose);
  if (focus) tab.focus();
}

tabs.forEach((t, i) => {
  t.addEventListener("click", () => pick(t, false));
  t.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    pick(tabs[(i + step + tabs.length) % tabs.length], true);
  });
});

document.querySelector(".window").addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tab = tabs.find((t) => t.querySelector("kbd").textContent === (e.key === " " ? "space" : e.key));
  if (!tab) return;
  e.preventDefault();
  pick(tab, true);
});
