#!/usr/bin/env bun
// Stands in for /usr/bin/osascript in tests and dev engines: logs its arguments and never scripts any app.
import { appendFileSync } from "node:fs";

if (process.env.FAKE_OSASCRIPT_LOG) appendFileSync(process.env.FAKE_OSASCRIPT_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
console.log("ATRIUM_SENT");
