import { showToast } from "./toast";

// A pressed Send waits this long before anything reaches Messages, so a slip can be taken back.
export const SEND_DELAY_MS = 5000;

// Shows "Sending to <name>… Undo" and calls send only once the window passes. Undo cancels it: nothing is sent and
// the card is left as it was.
export function sendWithUndo(name: string, send: () => void, onUndo: () => void): void {
  const timer = setTimeout(send, SEND_DELAY_MS);
  showToast(
    `Sending to ${name}…`,
    async () => {
      clearTimeout(timer);
      onUndo();
      return { ok: true };
    },
    SEND_DELAY_MS,
  );
}
