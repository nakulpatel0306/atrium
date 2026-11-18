# Security

Atrium runs AI agents on your Mac, so a hole in how it contains them matters. Thank you for looking.

## Reporting a vulnerability

Please report it privately, through GitHub: [open a private security advisory](https://github.com/nakulpatel0306/atrium/security/advisories/new) on this repo. Don't open a public issue for it.

Say what you did, what happened, and the commit you were on. Fixes land as public commits, and the advisory is published once the fix is in.

## Supported versions

Only the latest `main`.

## What's in scope

How agents are contained (the sandbox around each agent, what they can't read or reach, and why only Atrium pushes) is described on the site's [security page](https://nakulpatel0306.github.io/atrium/security.html), with its known limits. The ways a change can alter what its checks mean, and which stay open, are in [docs/loop.md](docs/loop.md#known-limits-of-the-gate). A way around any of these is in scope, and so is anything that lets a web page or another program on your Mac drive Atrium's engine on `127.0.0.1`.
