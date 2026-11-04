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
  function fakeSpawn() {
    const calls: string[][] = [];
    const exits: Array<() => void> = [];
    let kills = 0;
    const spawn = ((cmd: string[]) => {
      calls.push(cmd);
      let exit!: () => void;
      const exited = new Promise<number>((r) => (exit = () => r(0)));
      exits.push(exit);
      return { kill: () => void kills++, exited };
    }) as unknown as typeof Bun.spawn;
    return { spawn, calls, exits, kills: () => kills };
  }

  test("keepAwake start is idempotent and stop kills", () => {
    const f = fakeSpawn();
    const ka = createKeepAwake(f.spawn);
    ka.start();
    ka.start();
    expect(f.calls).toEqual([["caffeinate", "-i", "-s", "-w", String(process.pid)]]);
    expect(ka.active()).toBe(true);
    ka.stop();
    expect(f.kills()).toBe(1);
    expect(ka.active()).toBe(false);
    ka.stop();
    expect(f.kills()).toBe(1);
  });

  test("keepAwake forgets caffeinate when it exits on its own", async () => {
    const f = fakeSpawn();
    const ka = createKeepAwake(f.spawn);
    ka.start();
    f.exits[0]!();
    await Bun.sleep(0);
    expect(ka.active()).toBe(false);
    ka.start();
    expect(f.calls).toHaveLength(2);
    expect(ka.active()).toBe(true);
  });

  test("an old caffeinate exiting does not clear a newer one", async () => {
    const f = fakeSpawn();
    const ka = createKeepAwake(f.spawn);
    ka.start();
    ka.stop();
    ka.start();
    f.exits[0]!();
    await Bun.sleep(0);
    expect(ka.active()).toBe(true);
  });
});
