import pkg from "../../package.json" with { type: "json" };

// package.json is the one place the version is written; the CLI, the engine, `atrium doctor` and the Mac app read it.
export const VERSION: string = pkg.version;
