// Enter or Space on a row that acts as a button. A press aimed at a control inside the row stays that control's.
export function activateOnKey(e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void }, fn: () => void): void {
  if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  fn();
}
