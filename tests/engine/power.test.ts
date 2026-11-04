import { describe, expect, test } from "bun:test";
import { canRun, createKeepAwake, parsePmset } from "../../src/engine/power";

describe("parsePmset", () => {
  test("parsePmset detects AC", () => {
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged")).toBe("ac");
  });

  test("parsePmset detects battery", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging")).toBe("battery");
  });

  test("parsePmset treats unrecognised output as ac", () => {
    expect(parsePmset("")).toBe("ac");
  });
});

describe("canRun", () => {
  test("heavy task blocked on battery with plain reason", () => {
    expect(canRun({ weight: "heavy", allowOnBattery: false }, "battery")).toEqual({
      ok: false,
      reason: "Waiting for power: heavy work runs when plugged in",
    });
  });

  test("light task runs on battery", () => {
    expect(canRun({ weight: "light", allowOnBattery: false }, "battery")).toEqual({ ok: true });
  });

  test("heavy task with allowOnBattery runs on battery", () => {
    expect(canRun({ weight: "heavy", allowOnBattery: true }, "battery")).toEqual({ ok: true });
  });

  test("heavy task runs on ac", () => {
    expect(canRun({ weight: "heavy", allowOnBattery: false }, "ac")).toEqual({ ok: true });
  });
});

describe("keepAwake", () => {
  test("keepAwake start is idempotent and stop kills", () => {
    const calls: string[][] = [];
    let kills = 0;
    const fake = ((cmd: string[]) => {
      calls.push(cmd);
      return { kill: () => void kills++ };
    }) as unknown as typeof Bun.spawn;
    const ka = createKeepAwake(fake);
    ka.start();
    ka.start();
    expect(calls).toEqual([["caffeinate", "-i", "-s"]]);
    expect(ka.active()).toBe(true);
    ka.stop();
    expect(kills).toBe(1);
    expect(ka.active()).toBe(false);
    ka.stop();
    expect(kills).toBe(1);
  });
});
