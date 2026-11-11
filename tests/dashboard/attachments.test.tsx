import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandBar } from "../../src/dashboard/components/CommandBar";
import { LiveRegion } from "../../src/dashboard/components/LiveRegion";
import { TaskAttachments } from "../../src/dashboard/components/TaskAttachments";
import { pastedName } from "../../src/dashboard/attachments";
import type { State } from "../../src/engine/state";
import { makeState } from "../tui/fixtures";

type Space = State["spaces"][number];

let calls: { url: string; body: unknown }[] = [];
let root: Root | null = null;
const realFetch = globalThis.fetch;
let nextId = 0;

beforeEach(() => {
  calls = [];
  nextId = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/attachments")) {
      const files = (init!.body as FormData).getAll("file") as File[];
      calls.push({ url, body: files.map((f) => f.name) });
      return Response.json(files.map((f) => ({ id: `att_${++nextId}`, name: f.name, size: f.size, type: f.type })));
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return Response.json({ task: { id: "tsk_new", title: body?.text || "Look at the attached files." } });
  }) as typeof fetch;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  globalThis.fetch = realFetch;
});

openDom();
afterAll(() => closeDom());

const general = (): Space => makeState().spaces.find((s) => s.kind === "general")!;
const repoSpace = (): Space => makeState().spaces.find((s) => s.kind === "repo")!;

function render(space: Space | null): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() =>
    root!.render(
      <>
        <CommandBar space={space} setupRequest={0} />
        <LiveRegion />
      </>,
    ),
  );
  return el;
}

const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

// happy-dom has no DataTransfer to construct, so the event carries a stand-in with what the bar reads.
function fire(target: EventTarget, type: string, files: File[], key: "dataTransfer" | "clipboardData" = "dataTransfer") {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, key, { value: { types: ["Files"], files, dropEffect: "none" } });
  act(() => void target.dispatchEvent(e));
  return e;
}
const drop = (files: File[]) => {
  fire(window, "dragenter", files);
  fire(window, "dragover", files);
  return fire(window, "drop", files);
};

const chips = (el: HTMLElement) => [...el.querySelectorAll(".att-chip .att-name")].map((n) => n.textContent);
const said = (el: HTMLElement) => el.querySelector("[aria-live]")?.textContent ?? "";
// happy-dom's text inputs don't trip React's change tracking, so the typing goes straight to the input's onChange.
const typeIn = (el: HTMLElement, value: string) => {
  const input = el.querySelector<HTMLInputElement>('input[aria-label^="Give"]')!;
  const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
  const props = (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void }>)[key]!;
  act(() => props.onChange({ target: { value } }));
};
const send = async (el: HTMLElement) => {
  await act(async () => {
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};

test("dragging files shows the drop veil; a drop adds chips and says so", () => {
  const el = render(general());
  fire(window, "dragenter", [png("receipt.png")]);
  expect(document.body.textContent).toContain("Drop to attach");
  const e = fire(window, "drop", [png("receipt.png"), new File(["a,b"], "split.csv")]);
  // Claimed, so the web view never navigates to the file instead.
  expect(e.defaultPrevented).toBe(true);
  expect(document.body.textContent).not.toContain("Drop to attach");
  expect(chips(el)).toEqual(["receipt.png", "split.csv"]);
  expect(said(el)).toBe("Attached 2 files");
  expect(el.querySelector(".att-chip .att-size")!.textContent).toBe("4 B");
});

test("a pasted screenshot gets a dated name; a refused file is named and not added", () => {
  const el = render(general());
  fire(window, "paste", [png("image.png")], "clipboardData");
  expect(chips(el)).toHaveLength(1);
  expect(chips(el)[0]).toMatch(/^pasted-\d{4}-\d{2}-\d{2}-\d{4}\.png$/);
  expect(said(el)).toBe(`Attached ${chips(el)[0]}`);
  drop([new File(["x"], "setup.sh")]);
  expect(chips(el)).toHaveLength(1);
  expect(el.querySelector(".msg.err")!.textContent).toContain("setup.sh isn't a type Atrium can attach");
  drop([new File(["KEY=1"], ".env")]);
  expect(el.querySelector(".msg.err")!.textContent).toContain("looks like a secrets file");
});

test("pastedName keeps a real file name and dates a stand-in", () => {
  const at = new Date(2026, 10, 10, 14, 32);
  expect(pastedName(png("image.png"), at)).toBe("pasted-2026-11-10-1432.png");
  expect(pastedName(png("Pasted Graphic 2.png"), at)).toBe("pasted-2026-11-10-1432.png");
  expect(pastedName(png("receipt.png"), at)).toBe("receipt.png");
});

test("remove takes a chip away and says so", () => {
  const el = render(general());
  drop([png("receipt.png"), png("menu.png")]);
  const x = el.querySelector<HTMLButtonElement>('button[aria-label="Remove receipt.png"]')!;
  act(() => x.click());
  expect(chips(el)).toEqual(["menu.png"]);
  expect(said(el)).toBe("Removed receipt.png");
});

test("sending uploads the files, then posts the task with their ids, and clears the chips", async () => {
  const space = general();
  const el = render(space);
  drop([png("receipt.png"), png("menu.png")]);
  typeIn(el, "Split this three ways");
  await send(el);
  expect(calls).toEqual([
    { url: `/api/spaces/${space.id}/attachments`, body: ["receipt.png", "menu.png"] },
    { url: "/api/command", body: { text: "Split this three ways", spaceId: space.id, agent: "auto", attachments: ["att_1", "att_2"] } },
  ]);
  expect(chips(el)).toEqual([]);
  expect(el.querySelector(".msg")!.textContent).toContain("with 2 files");
});

test("files alone can be sent in a space; on Home they wait for a description", async () => {
  const el = render(general());
  drop([png("receipt.png")]);
  await send(el);
  expect(calls.at(-1)).toEqual({ url: "/api/command", body: { text: "", spaceId: general().id, agent: "auto", attachments: ["att_1"] } });
  act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();

  calls = [];
  const home = render(null);
  drop([png("receipt.png")]);
  await send(home);
  expect(calls).toEqual([]);
  expect(home.querySelector(".msg")!.textContent).toContain("Say what the new space is for first");
  expect(chips(home)).toEqual(["receipt.png"]);
});

test("chips survive moving to another space before sending", () => {
  const el = render(null);
  drop([png("receipt.png")]);
  act(() => root!.render(<CommandBar space={general()} setupRequest={0} />));
  expect(chips(el)).toEqual(["receipt.png"]);
});

test("in a repo space the paperclip says why it's off, and a drop isn't attached", () => {
  const el = render(repoSpace());
  const clip = el.querySelector<HTMLButtonElement>("button.attach")!;
  expect(clip.getAttribute("aria-disabled")).toBe("true");
  expect(clip.title).toBe("Attach files in a regular space for now.");
  fire(window, "dragenter", [png("receipt.png")]);
  expect(document.body.textContent).toContain("Attach files in a regular space for now.");
  fire(window, "drop", [png("receipt.png")]);
  expect(chips(el)).toEqual([]);
});

test("the paperclip is labelled and opens a multi-file picker for the allowed types", () => {
  const el = render(general());
  expect(el.querySelector("button.attach")!.getAttribute("aria-label")).toBe("Attach files");
  const picker = el.querySelector<HTMLInputElement>("input[type=file]")!;
  expect(picker.multiple).toBe(true);
  expect(picker.accept.split(",")).toContain(".png");
  expect(picker.accept.split(",")).not.toContain(".env");
});

test("a task's attached files show as a list with thumbnails for images", () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  const base = { spaceId: "spc_1", taskId: "tsk_1", size: 2048, createdAt: 1 };
  act(() =>
    root!.render(
      <TaskAttachments
        attachments={[
          { ...base, id: "att_1", path: "Attachments/receipt.png", name: "receipt.png", type: "image/png" },
          { ...base, id: "att_2", path: "Attachments/lease.pdf", name: "lease.pdf", type: "application/pdf" },
        ]}
      />,
    ),
  );
  const items = [...el.querySelectorAll(".att-file")];
  expect(items.map((i) => i.querySelector(".att-name")!.textContent)).toEqual(["receipt.png", "lease.pdf"]);
  expect(items[0]!.querySelector("img")!.getAttribute("src")).toBe("/api/spaces/spc_1/file/raw?path=Attachments%2Freceipt.png");
  expect(items[1]!.querySelector("img")).toBeNull();
});
