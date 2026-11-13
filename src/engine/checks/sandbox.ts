import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { SANDBOX_EXEC, codexStateDir, seatbeltProfile } from "../agents/seatbelt";

// Ports an Atrium engine listens on: the configured one, the default 7420, and the block just above it that dev
// and test engines use (the README's dev engine is 7421).
const ENGINE_PORTS = Array.from({ length: 20 }, (_, i) => 7420 + i);
// SSH, plus local services that hand out control of the machine: CUPS admin, Docker's API, VNC, Kubernetes,
// and the Chrome and Node debuggers.
const ADMIN_PORTS = [22, 631, 2375, 2376, 5900, 6443, 9222, 9229];

// The project's checks, and only those, get this profile: the agent profile word for word, then loopback opened
// so a test can start and call its own server, with the internet, Atrium's ports and admin ports shut. Agents
// never run under it; their profile keeps loopback denied. Later rules win in Seatbelt, so the additions follow.
// Spelled with tcp and udp on purpose: Seatbelt drops a port-specific deny that follows an `ip` allow, which
// would leave a denied port open (checked against sandbox-exec).
export function checkProfile(cwd: string, writable: string[]): string {
  const shut = [...new Set([config().port, ...ENGINE_PORTS, ...ADMIN_PORTS])];
  return [
    seatbeltProfile({ cwd, writable, extraDenyRead: [codexStateDir(), join(homedir(), ".gemini")], denyKeychain: true }),
    '(deny network-outbound (remote tcp "*:*") (remote udp "*:*"))',
    '(allow network-outbound (remote tcp "localhost:*") (remote udp "localhost:*"))',
    `(deny network-outbound ${shut.map((p) => `(remote tcp "localhost:${p}")`).join(" ")})`,
  ].join("\n");
}

export function wrapCheck(argv: string[], cwd: string, writable: string[], sandboxExec: string = SANDBOX_EXEC): string[] {
  return [sandboxExec, "-p", checkProfile(cwd, writable), ...argv];
}
