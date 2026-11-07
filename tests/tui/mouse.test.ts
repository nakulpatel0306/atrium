import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ESC_HOLD_MS, filteredStdin, type MouseEvent, mouseFilter } from "../../src/tui/mouse";

const run = (...chunks: string[]) => {
  const events: MouseEvent[] = [];
  const filter = mouseFilter((e) => events.push(e));
  const out = chunks.map(filter).join("");
  return { out, events };
};

test("a click becomes an event at 0-based cells and leaves no text behind", () => {
  expect(run("\x1b[<0;25;1M\x1b[<0;25;1m")).toEqual({ out: "", events: [{ kind: "click", x: 24, y: 0 }] });
});

test("the wheel scrolls; right clicks, releases and drags are ignored", () => {
  expect(run("\x1b[<64;3;4M\x1b[<65;3;4M").events).toEqual([
    { kind: "wheel", x: 2, y: 3, dir: -1 },
    { kind: "wheel", x: 2, y: 3, dir: 1 },
  ]);
  expect(run("\x1b[<2;3;4M\x1b[<32;3;4M\x1b[<0;3;4m").events).toEqual([]);
});

test("keys and escapes around a report pass through untouched", () => {
  expect(run("j\x1b[<0;1;1Mk\x1b[A\x1bq").out).toBe("jk\x1b[A\x1bq");
});

test("a report cut across two reads is held until its end arrives", () => {
  expect(run("a\x1b[<0;1", "0;2Mb")).toEqual({ out: "ab", events: [{ kind: "click", x: 9, y: 1 }] });
});

test("a report cut right after ESC or ESC[ is held for the rest, and a lone Esc still reaches Ink", async () => {
  expect(run("j\x1b[", "<0;3;4M")).toEqual({ out: "j", events: [{ kind: "click", x: 2, y: 3 }] });
  expect(run("\x1b", "[<0;3;4M")).toEqual({ out: "", events: [{ kind: "click", x: 2, y: 3 }] });
  const flushed: string[] = [];
  const filter = mouseFilter(() => {}, (t) => flushed.push(t));
  expect(filter("\x1b")).toBe("");
  await new Promise((r) => setTimeout(r, ESC_HOLD_MS + 20));
  expect(flushed).toEqual(["\x1b"]);
});

test("inside a bracketed paste nothing is taken out", () => {
  const pasted = "\x1b[200~look \x1b[<0;1;1M here\x1b[201~";
  expect(run(pasted)).toEqual({ out: pasted, events: [] });
  expect(run("\x1b[200~half ", "\x1b[<0;1;1M\x1b[201~", "\x1b[<0;2;2M").events).toEqual([{ kind: "click", x: 1, y: 1 }]);
});

test("the stand-in stdin forwards raw mode and hands Ink only the text", async () => {
  const real = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode(m: boolean): unknown };
  const raw: boolean[] = [];
  (real as unknown as { setRawMode(m: boolean): void }).setRawMode = (m: boolean) => void raw.push(m);
  (real as unknown as { ref(): void; unref(): void }).ref = () => {};
  (real as unknown as { ref(): void; unref(): void }).unref = () => {};
  const clicks: MouseEvent[] = [];
  const stdin = filteredStdin(real, (e) => clicks.push(e)) as unknown as NodeJS.ReadStream & { setRawMode(m: boolean): unknown };
  expect(stdin.isTTY).toBe(true);
  stdin.setRawMode(true);
  expect(raw).toEqual([true]);
  (real as unknown as PassThrough).write("q\x1b[<0;5;6M");
  await new Promise((r) => setTimeout(r, 10));
  expect(String(stdin.read())).toBe("q");
  expect(clicks).toEqual([{ kind: "click", x: 4, y: 5 }]);
  stdin.setRawMode(false);
  expect(raw).toEqual([true, false]);
});
