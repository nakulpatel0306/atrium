// The top bar's menu on narrow screens: a <details> that works without script; this closes it after a pick, on Esc,
// or on a tap outside it.
const menu = document.querySelector(".bar details.menu");
if (menu) {
  const close = () => menu.removeAttribute("open");
  menu.addEventListener("click", (e) => {
    if (e.target.closest("a")) close();
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.open) {
      close();
      menu.querySelector("summary").focus();
    }
  });
  addEventListener("click", (e) => {
    if (menu.open && !menu.contains(e.target)) close();
  });
}
