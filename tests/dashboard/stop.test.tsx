import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StopTask } from "../../src/dashboard/components/StopTask";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("a running task offers Stop; nothing else does", () => {
  const s = makeState();
  const running = s.tasks.find((t) => t.id === ids.running)!;
  expect(text(renderToStaticMarkup(<StopTask task={running} />))).toBe("Stop…");
  for (const t of s.tasks.filter((x) => x.status !== "running")) expect(renderToStaticMarkup(<StopTask task={t} />)).toBe("");
});
