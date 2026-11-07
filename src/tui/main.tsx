import { writeSync } from "node:fs";
import { render } from "ink";
import "./color-env";
import { createClient } from "./client";
import { App } from "./components/App";
import { filteredStdin, MOUSE_OFF, MOUSE_ON, mouseBus } from "./mouse";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("atrium needs a terminal to open the app. Try: atrium status");
  process.exit(1);
}

const client = createClient();
const mouse = mouseBus();
const stdin = filteredStdin(process.stdin as Parameters<typeof filteredStdin>[0], mouse.emit);
const app = render(<App client={client} mouse={mouse} />, { alternateScreen: true, exitOnCtrlC: true, stdin });

// Mouse reporting left on after exit would fill the user's shell with escape codes on every click, so it's turned
// off on every way out: quit, crash, signal, and process exit as the last resort.
let mouseOn = false;
const mouseOff = () => {
  if (!mouseOn) return;
  mouseOn = false;
  try {
    writeSync(1, MOUSE_OFF);
  } catch {
    // stdout is gone; there's no terminal left to fix.
  }
};
process.stdout.write(MOUSE_ON);
mouseOn = true;
process.on("exit", mouseOff);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    mouseOff();
    app.unmount();
    client.close();
    process.exit(0);
  });
}

// The alternate screen must be left before an error is printed, or the terminal stays in the app's screen.
const crash = (e: unknown) => {
  mouseOff();
  app.unmount();
  client.close();
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

await app.waitUntilExit();
mouseOff();
client.close();
process.exit(0);
