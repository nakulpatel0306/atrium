// The decision keys on a page that isn't the queue (a space, a task opened in it): a, s, x and e press a button the
// open task already shows, so a key can't do what a click wouldn't, and never one the user can't see.

// Whether the user can see an element: nothing above it is display:none or hidden, and it isn't in the folded part of a
// closed <details>.
export function isShown(el: Element | null): boolean {
  for (let at: Element | null = el; at; at = at.parentElement) {
    if (at.hasAttribute("hidden") || getComputedStyle(at).display === "none") return false;
    const fold = at.parentElement;
    if (fold?.tagName === "DETAILS" && !(fold as HTMLDetailsElement).open && at.tagName !== "SUMMARY") return false;
  }
  return true;
}

export type Pressable = { button: HTMLButtonElement; scope: HTMLElement } | { none: true } | { many: true };

// The button a key presses: in the open task the focus is in, else in the one open task that shows it. Two open tasks
// that both could take it are left for the user to pick, rather than guessed.
export function pressable(scopes: HTMLElement[], act: string, focus: Element | null): Pressable {
  const shown = scopes.filter(isShown);
  const buttonIn = (scope: HTMLElement) => [...scope.querySelectorAll<HTMLButtonElement>(`[data-act="${act}"]`)].find((b) => !b.disabled && isShown(b));
  const focused = focus ? shown.find((s) => s.contains(focus)) : undefined;
  const able = focused ? [focused] : shown.filter(buttonIn);
  if (able.length > 1) return { many: true };
  const scope = able[0];
  const button = scope && buttonIn(scope);
  return scope && button ? { button, scope } : { none: true };
}
