import { describe, expect, test } from "bun:test";
import { chooseShape, FAN_OUT, fanOutEstimate, partPath, proposeShape, shapeChoices, shapeLine, storedShape } from "../../src/engine/shape";

const medium = { size: "medium" as const, checksFound: true };
const parts = [
  { title: "Add the endpoint", goal: "Serve totals", files: ["src/api/totals.ts"] },
  { title: "Write the docs", goal: "Document totals", files: ["docs/totals.md"] },
];

describe("the pre-pass's proposal", () => {
  test("is kept when the task supports it, with its reason, and is never approved", () => {
    const shape = proposeShape({ kind: "split", reason: "two independent pieces", parts, approved: true }, medium);
    expect(shape).toMatchObject({ kind: "split", reason: "two independent pieces", proposed: "split", approved: false });
    expect(shapeLine(shape)).toBe("Split into 2 tasks: two independent pieces");
  });

  test("defaults to one writer for anything it can't read", () => {
    expect(proposeShape(null, medium)).toMatchObject({ kind: "single", proposed: "single" });
    expect(proposeShape({ kind: "swarm" }, medium).kind).toBe("single");
  });

  test("a split whose parts share a file, or a folder holding one, runs as one writer and says why", () => {
    const shared = proposeShape({ kind: "split", parts: [parts[0], { ...parts[1], files: ["SRC/api"] }] }, medium);
    expect(shared).toMatchObject({ kind: "single", proposed: "split", reason: "Two of the parts touch the same files, so one writer does it." });
    expect(proposeShape({ kind: "split", parts: [parts[0], { ...parts[1], files: [] }] }, medium).kind).toBe("single");
    expect(proposeShape({ kind: "split", parts: [parts[0]] }, medium).kind).toBe("single");
  });

  test("a part's paths must name files inside the repo, and overlap is judged on the paths as they resolve", () => {
    const split = (a: string[], b: string[]) => proposeShape({ kind: "split", parts: [{ ...parts[0], files: a }, { ...parts[1], files: b }] }, medium);
    const outside = "A part named a path outside the repo, a pattern or the whole repo, so one writer does it.";
    for (const bad of ["/", ".", "./", "/etc/hosts", "~/notes.md", "../../outside/x.ts", "src/../src/math.ts", "src/**", "src/*.ts", "src\\a.ts"]) {
      expect([bad, split([bad], ["docs/totals.md"]).reason]).toEqual([bad, outside]);
    }
    expect(split(["./src/api/totals.ts"], ["SRC/API/"]).reason).toBe("Two of the parts touch the same files, so one writer does it.");
    expect(split(["src/./api/totals.ts"], ["docs/totals.md"]).kind).toBe("split");
    expect(partPath("src//api/./x.ts/")).toBe("src/api/x.ts");
    // APFS treats a name and its NFC form as one file.
    expect(split(["src/cafe\u0301.ts"], ["src/caf\u00e9.ts"]).reason).toBe("Two of the parts touch the same files, so one writer does it.");
  });

  test("a small task never splits or tries attempts, and says so plainly", () => {
    expect(proposeShape({ kind: "split", parts }, { size: "small", checksFound: true }).reason).toBe("A small task runs as one writer.");
    // The attempts count stays two or three, so no label ever reads "Best of 1".
    expect(proposeShape({ kind: "best_of_n", attempts: 1 }, { size: "small", checksFound: true }).attempts).toBe(2);
  });

  test("fan-out is capped by size: a small task never fans out, a large one at most five ways", () => {
    expect(proposeShape({ kind: "split", parts }, { size: "small", checksFound: true }).kind).toBe("single");
    const six = Array.from({ length: 6 }, (_, i) => ({ title: `P${i}`, goal: "g", files: [`f${i}.ts`] }));
    expect(proposeShape({ kind: "split", parts: six }, { size: "large", checksFound: true }).kind).toBe("single");
    expect(proposeShape({ kind: "split", parts: six.slice(0, 5) }, { size: "large", checksFound: true }).kind).toBe("split");
    expect(proposeShape({ kind: "scouts", scouts: ["a", "b", "c", "d", "e", "f"] }, medium).scouts).toHaveLength(FAN_OUT.medium);
  });

  test("best-of-N needs a check to pick with and isn't for small tasks; it runs two or three attempts", () => {
    expect(proposeShape({ kind: "best_of_n", attempts: 9 }, medium)).toMatchObject({ kind: "best_of_n", attempts: 3 });
    expect(proposeShape({ kind: "best_of_n" }, { size: "medium", checksFound: false })).toMatchObject({ kind: "single", reason: "No automatic check to pick between attempts." });
    expect(proposeShape({ kind: "best_of_n" }, { size: "small", checksFound: true }).kind).toBe("single");
  });

  test("scouts with no questions are just one writer", () => {
    expect(proposeShape({ kind: "scouts", scouts: [] }, medium).kind).toBe("single");
  });
});

describe("the user's choice", () => {
  test("approves a costlier shape; the menu says why the others aren't open", () => {
    const shape = proposeShape({ kind: "single", parts }, medium);
    expect(chooseShape(shape, "split", medium, "Totals")).toMatchObject({ kind: "split", approved: true, reason: "your choice" });
    expect(chooseShape(shape, "best_of_n", medium, "Totals", { mixVendors: true })).toMatchObject({ approved: true, mixVendors: true });
    expect(chooseShape(shape, "single", medium, "Totals").approved).toBe(false);
    const noChecks = { size: "medium" as const, checksFound: false };
    expect(shapeChoices(proposeShape({}, noChecks), noChecks)).toEqual([
      { kind: "single", why: null },
      { kind: "scouts", why: null },
      { kind: "split", why: "It didn't find independent parts to split into." },
      { kind: "best_of_n", why: "No automatic check to pick between attempts." },
    ]);
    expect(() => chooseShape(proposeShape({}, noChecks), "best_of_n", noChecks, "x")).toThrow();
  });

  test("scouts chosen without the pre-pass's questions send one scout to map the goal's code", () => {
    expect(chooseShape(proposeShape({}, medium), "scouts", medium, "Show totals").scouts).toEqual(["Find the code this task touches and how it fits together: Show totals"]);
  });
});

test("a stored shape is read strictly: only a literal true approves, and anything off reads as no shape", () => {
  const shape = chooseShape(proposeShape({ kind: "split", parts }, medium), "split", medium, "x");
  expect(storedShape(JSON.parse(JSON.stringify(shape)))).toEqual(shape);
  expect(storedShape({ ...shape, approved: "yes" })!.approved).toBe(false);
  expect(storedShape({ ...shape, kind: "everything" })).toBeNull();
  expect(storedShape("split")).toBeNull();
});

test("a fan-out's estimate comes from the space's recent tasks, or each run's budget when there are none", () => {
  const spend = (weighted: number, usd: number, unpriced = 0) => ({ weighted, usd, unpriced, cacheRead: 0, input: 0 });
  expect(fanOutEstimate(3, [spend(100_000, 1), spend(300_000, 3)], 600_000)).toEqual({ weighted: 600_000, usd: 6, basis: "recent" });
  expect(fanOutEstimate(3, [spend(100_000, 0, 100_000)], 600_000)).toEqual({ weighted: 300_000, usd: null, basis: "recent" });
  expect(fanOutEstimate(2, [], 600_000)).toEqual({ weighted: 1_200_000, usd: null, basis: "budget" });
});
