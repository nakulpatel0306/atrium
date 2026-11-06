import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYou } from "../../src/dashboard/components/NeedsYou";
import { approveLabel, OutcomeBanner, outcomeText } from "../../src/dashboard/components/OutcomeBanner";
import { SpaceView } from "../../src/dashboard/components/SpaceView";
import { StatusIcon } from "../../src/dashboard/components/StatusIcon";
import type { Outcome } from "../../src/engine/outcome";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const withOutcome = (outcome: Outcome, reason: string | null) => {
  const s = makeState();
  const t = s.tasks.find((x) => x.id === ids.review)!;
  t.outcome = outcome;
  t.outcomeReason = reason;
  return s;
};

test("banner copy", () => {
  expect(outcomeText("couldnt", "no number.")).toBe("Couldn't do this: no number.");
  expect(outcomeText("couldnt", null)).toBe("Couldn't do this: The agent didn't say why.");
  expect(outcomeText("partial", "one file left.")).toBe("Partly done: one file left.");
  expect(outcomeText("partial", null)).toBe("Partly done: The agent didn't say what's left.");
  expect(outcomeText("unknown", null)).toBe("Atrium can't tell whether this was done. The agent didn't say, so check the summary.");
  expect(renderToStaticMarkup(<OutcomeBanner outcome="done" reason={null} />)).toBe("");
  expect(renderToStaticMarkup(<OutcomeBanner outcome={null} reason={null} />)).toBe("");
  expect([approveLabel("couldnt"), approveLabel("partial"), approveLabel("unknown"), approveLabel(null)]).toEqual(["Accept anyway", "Accept as is", "Approve", "Approve"]);
});

test("a Needs you row says couldn't, above the summary, and asks to accept anyway", () => {
  const html = renderToStaticMarkup(<NeedsYou state={withOutcome("couldnt", "the file isn't there.")} />);
  const t = text(html);
  expect(t).toContain("Couldn't do this: the file isn't there.");
  expect(t).toContain("Accept anyway");
  expect(t).not.toContain("Approve");
  expect(html.indexOf("outcome-banner")).toBeLessThan(html.indexOf("Send back</button>") + 2000);
  const partial = text(renderToStaticMarkup(<NeedsYou state={withOutcome("partial", "one left.")} />));
  expect(partial).toContain("Partly done: one left.");
  expect(partial).toContain("Accept as is");
  const unknown = renderToStaticMarkup(<NeedsYou state={withOutcome("unknown", null)} />);
  expect(unknown).toContain("outcome-banner unknown");
  expect(text(unknown)).toContain("Approve");
});

test("a done task that wasn't done never shows the done check", () => {
  const notDone = renderToStaticMarkup(<StatusIcon status="done" outcome="couldnt" />);
  expect(notDone).toContain('aria-label="Not done"');
  expect(notDone).toContain("stat notdone");
  expect(renderToStaticMarkup(<StatusIcon status="done" outcome="partial" />)).toContain('aria-label="Partly done"');
  expect(renderToStaticMarkup(<StatusIcon status="done" outcome="done" />)).toContain('aria-label="Done"');
  const s = withOutcome("couldnt", "no number.");
  s.tasks.find((x) => x.id === ids.review)!.status = "done";
  const html = renderToStaticMarkup(<SpaceView state={s} space={s.spaces.find((x) => x.id === ids.atrium)!} focusTask={ids.review} />);
  expect(text(html)).toContain("not done");
  expect(html).not.toContain('aria-label="Done"');
  expect(text(html)).toContain("Couldn't do this: no number.");
});
