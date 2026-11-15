# Contributing

Thanks for looking. Atrium is a bun/TypeScript engine with a React dashboard, an Ink terminal app and a small Swift Mac app. The rules every change follows are in [CLAUDE.md](CLAUDE.md); how a coding task runs is in [docs/loop.md](docs/loop.md); how the pieces fit is in [docs/architecture.md](docs/architecture.md).

## Set up

```sh
bun install
ATRIUM_HOME=$(mktemp -d) ATRIUM_PORT=7421 bun src/main.ts   # a dev engine beside any installed one
```

A dev engine needs its own `ATRIUM_HOME` and a port other than 7420, so it never touches a real install. Point it at the fake agents in `tests/fixtures` (`ATRIUM_CLAUDE_BIN=tests/fixtures/fake-claude.ts`, and the same for Codex, Gemini and `gh`) to work on the interface without spending tokens.

## Tests

Run the suite in groups, passing each path as its own argument. Plain `bun test` runs only `tests/` (see `bunfig.toml`): the sample repo under `assets/` has a test that fails on purpose.

```sh
bun test tests/engine --timeout 120000
bun test tests/server tests/dashboard
bun test tests/tui tests/copy
bun test tests/cli.test.ts tests/main.test.ts
bun test tests/e2e
bun test tests/mac
bunx tsc --noEmit
```

- No test reaches the network. Agents, `gh`, `open` and the Keychain are fakes from `tests/fixtures`.
- Every test sets `ATRIUM_HOME` to a temp folder (`tempHome()` in `tests/helpers.ts`).
- Behaviour changes come with a test first. The queue and the diff view have render budgets in `tests/dashboard`; keep them passing.
- `tests/copy` checks interface wording against [docs/copy-inventory.md](docs/copy-inventory.md): sentence-case buttons, real ellipses, errors that say what to do next.
- Database migrations only add, and each gets a test against a database shaped like an older install.

## Before you share a branch

```sh
bun run leak-check                        # names, paths and secrets that mustn't be in a public repo
bun run leak-check --denylist ~/my-terms  # plus your own private terms, kept outside the repo
```

- Test data is always made up: invented names and `example.com` addresses.
- Screenshots for the README come from a throwaway engine with made-up data and fake agents, never a real install.
- Commits are small, with an imperative subject under 72 characters and no `Co-Authored-By` or "Generated with" trailers.

## Design rules worth knowing

- Anything a model produces is a proposal: it never widens what runs, raises a budget or picks a command the checks trust. Untrusted text reaches a prompt fenced.
- Every Claude call goes through the adapter in `src/engine/agents/claude.ts` with an explicit, minimal `--tools` list.
- What counts as needing the user lives in one place, `src/engine/needs.ts`, and every surface (dashboard, terminal app, Mac app, `atrium status`) reads it.
- Stored state is read field by field over strict defaults, so an older or odd value never breaks a newer engine.
