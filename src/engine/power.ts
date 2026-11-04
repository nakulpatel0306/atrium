import type { Task } from "./tasks";

export type PowerSource = "ac" | "battery";

export function parsePmset(output: string): PowerSource {
  // Desktops print no battery line, so anything unrecognised counts as AC.
  return /Now drawing from 'Battery Power'/.test(output) ? "battery" : "ac";
}

export async function powerSource(): Promise<PowerSource> {
  const proc = Bun.spawn(["pmset", "-g", "batt"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parsePmset(out);
}

export function canRun(
  task: Pick<Task, "weight" | "allowOnBattery">,
  source: PowerSource,
): { ok: true } | { ok: false; reason: "Waiting for power: heavy work runs when plugged in" } {
  if (source === "battery" && task.weight === "heavy" && !task.allowOnBattery) {
    return { ok: false, reason: "Waiting for power: heavy work runs when plugged in" };
  }
  return { ok: true };
}

export function createKeepAwake(spawnFn: typeof Bun.spawn = Bun.spawn) {
  let proc: { kill(): void; exited: Promise<number> } | null = null;
  return {
    start() {
      if (proc) return;
      // -w ties caffeinate to the engine, so a crashed engine never leaves the Mac awake.
      const child = spawnFn(["caffeinate", "-i", "-s", "-w", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
      proc = child;
      // If caffeinate dies on its own, forget it so the next start() respawns it.
      child.exited.then(() => {
        if (proc === child) proc = null;
      });
    },
    stop() {
      proc?.kill();
      proc = null;
    },
    active: () => proc !== null,
  };
}

export const keepAwake = createKeepAwake();
