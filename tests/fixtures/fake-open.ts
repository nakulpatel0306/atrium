#!/usr/bin/env bun
// Stands in for /usr/bin/open in tests and dev engines: logs its arguments instead of launching anything.
import { appendFileSync } from "node:fs";

if (process.env.FAKE_OPEN_LOG) appendFileSync(process.env.FAKE_OPEN_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
process.exit(Number(process.env.FAKE_OPEN_EXIT ?? 0));
