// The terminal page: tabs between the app's screens (arrows, Home and End move between them), and Plum taking the
// pose that fits each one. With focus inside the window, the keys printed on the tabs (1, ?, space, 2) switch
// screens as they do in the app.
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
  // The Ask box is at the foot of the app, so its screen opens scrolled to it.
  const panel = document.getElementById(tab.getAttribute("aria-controls"));
  panel.scrollTop = tab.id === "s-ask" ? panel.scrollHeight : 0;
  if (focus) tab.focus();
}

tabs.forEach((t, i) => {
  t.addEventListener("click", () => pick(t, false));
  t.addEventListener("keydown", (e) => {
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    pick(tabs[(to + tabs.length) % tabs.length], true);
  });
});

document.querySelector(".window").addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // Space and Enter on a focused tab press that tab, as on any button.
  if ((e.key === " " || e.key === "Enter") && e.target.closest("[role=tab]")) return;
  const tab = tabs.find((t) => t.querySelector("kbd").textContent === (e.key === " " ? "space" : e.key));
  if (!tab) return;
  e.preventDefault();
  pick(tab, true);
});
