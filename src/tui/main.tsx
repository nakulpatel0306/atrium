import { render } from "ink";
import { createClient } from "./client";
import { App } from "./components/App";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("atrium needs a terminal to open the app. Try: atrium status");
  process.exit(1);
}

const client = createClient();
const app = render(<App client={client} />, { alternateScreen: true, exitOnCtrlC: true });

// The alternate screen must be left before an error is printed, or the terminal stays in the app's screen.
const crash = (e: unknown) => {
  app.unmount();
  client.close();
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

await app.waitUntilExit();
client.close();
process.exit(0);
