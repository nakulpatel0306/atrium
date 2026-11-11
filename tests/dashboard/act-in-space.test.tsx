import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SpaceNeeds } from "../../src/dashboard/components/NeedsYou";
import { SpaceView } from "../../src/dashboard/components/SpaceView";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a space lists what's waiting on you there, with the same answers as Needs you", () => {
  const s = makeState();
  const t = text(renderToStaticMarkup(<SpaceNeeds state={s} spaceId={ids.atrium} />));
  expect(t).toContain("Waiting for you · 1");
  expect(t).toContain("Review: Fix login redirect");
  expect(t).toContain("Send back");
  expect(t).toContain("Approve");
  expect(renderToStaticMarkup(<SpaceNeeds state={s} spaceId={ids.jobHunt} />)).toBe("");
});

test("a task in review offers Approve and Send back in its own detail", () => {
  const s = makeState();
  const space = s.spaces.find((x) => x.id === ids.atrium)!;
  const html = renderToStaticMarkup(<SpaceView state={s} space={space} focusTask={ids.review} />);
  const detail = html.slice(html.indexOf(`id="task-${ids.review}"`));
  expect(text(detail)).toContain("Waiting for your review");
  expect(detail).toContain('data-act="approve"');
});
