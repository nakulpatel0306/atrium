# The loop

Every coding task in Atrium runs the same loop: **brief → write → verify → review → you.** You see a result only after Atrium's own checks and a fresh reviewer have been at it, with what each found attached. Everything here works with only the Claude CLI installed; Codex and Gemini only widen the choice of reviewer.

Why this shape: in studies of agent failures, about 44% come from the task spec (agents ignoring it, repeating steps, not knowing when they're done) and about 24% from weak or missing verification. When maintainers reviewed agent pull requests that had passed a benchmark's tests, roughly half were still not mergeable. A clean-context reviewer finds real problems that the agent which wrote the code stopped seeing. So the levers are a better brief, a check the agent can't fake, and an independent read for mergeability, not more agents.

## The brief

Press Enter in the ask bar and a small, fast Claude model (through the CLI, read-only on the repo, a few turns at most) drafts a brief under the ask:

- **Goal**: one sentence.
- **Acceptance criteria**: what has to be true when it's done. General spaces call these "done when".
- **Check with**: a command that proves it, or `auto` for the checks Atrium finds.
- **Scope** and **not in scope**, **look at first** (files), and a **size** (small, medium, large) that sets the default budget.

The pre-pass asks at most two questions, and only when the ask could reasonably mean two different things; answers are one tap or a short text and travel with the brief. One-line hints point at gaps, such as "No way to check this is done: add a test command or acceptance check."

Every field is editable and none is required. **Run** starts the task. **⌘↩** on the ask skips the brief and sends the one-liner straight away, exactly as fast as before briefs existed.

The brief reaches the writer as sections of its prompt, including the commands that will check it, and the reviewer as the thing to judge against. General spaces get the light version (goal and done when) and no checks or review.

## Checks

Atrium finds a repo's checks from the commit the task started on:

- `package.json` scripts (typecheck, lint, test), with the package manager the lockfile names; `tsc --noEmit` when the project uses TypeScript without a typecheck script; `bun test` for bun projects with test files.
- Commands named in `CLAUDE.md` or `AGENTS.md`.
- `Makefile` targets (typecheck or check, lint, test).
- `pyproject.toml` (mypy, ruff, pytest, through `uv run` or `poetry run` when locked that way), `Cargo.toml` (check, clippy, test) and `go.mod` (vet, test).

A space's own commands (Settings in the space header, one per line, the last being the full test run) replace detection, and a brief's own check command replaces the test run. Detection is cached per commit.

After every writer turn that changed files, the engine runs the checks itself in the task's checkout, before the repo goes back to your branch: the engine's dependency install first when the change touched the manifest or lockfile, then the fast checks (typecheck, lint), then the full test run. Each command has a time limit and its output is capped. Afterwards the tree is put back to the commit, so build output and caches never block the switch back. A failing turn goes back to the writer with the end of the failing output. The agent's own "tests pass" is never taken as a result.

The task carries `checks: pending | running | passed | failed | none`, shown as a badge on its row with the output one click away. "Ready for you" means passed, or `none`, labelled "Unverified: no checks found" with a hint to add one.

## Gate threat model

The writer works in the same tree the checks run in, so tampering can't be made impossible. The gate is built on this model, and every mechanism above follows from it; nothing goes beyond it.

- **The writer agent is semi-trusted.** It runs sandboxed and may be prompt-injected by what it reads.
- **Check results are evidence, not proof.** Check commands execute repo code the writer can change, and the tests themselves are writer-editable.
- **The gate guarantees:**
  1. **Checks can't reach secrets, Atrium's API or ports, or files outside the worktree.** They run under a sandbox profile of their own: the agent profile word for word (no credentials, `.env` files or Keychain; writes only in the worktree and a private temp folder; none into `node_modules` or `.venv`), then loopback opened for tests that start their own server, with the internet, every port an Atrium engine listens on, SSH and local admin ports shut. Their environment is built from scratch, so no token reaches them. Agents never run under this profile; theirs keeps loopback shut.
  2. **The command definitions come from the base commit.** Package scripts run as their text from the commit the task started on, not `npm run <name>`; a Makefile and every makefile it includes run from base copies. Only package-manager checks get `node_modules/.bin` on `PATH`, and no other worktree path is ever put ahead of the system's.
  3. **Every known route that changes what the checks mean is closed, or produces an attention note.** Agents can't write the dependency folders the checks run tools from; only the engine's install does, from the lockfile, with lifecycle scripts off, its own sandbox (writes only to those folders and its cache), and a minimal environment. A change to install-time config (`.npmrc`, `.yarnrc*`, `.yarn/releases`, `.pnpmfile.cjs`, `bunfig.toml`, `pip.conf`, `uv.toml`, …) is never installed: its checks are marked "Unverified: this change edits how dependencies install". Edits to check config, manifests and lockfiles, CI scripts the checks call, fewer test files than the base, and newly skipped tests each add a note. Paths are classified across everything the work touched, committed or left in the tree (untracked and ignored files too), with case folded as APFS does. A note blocks automatic approval by any rule, is put to the reviewer to scrutinise, and is shown on the result.
- **The reviewer and you are the final judges.**

### Known limits of the gate

- **Editing the tests themselves.** A writer can weaken an assertion without dropping a file or adding a skip. The reviewer is told to judge against the brief, and you see the diff.
- **Repo code the checks call.** Tests, source and helper scripts are the writer's to change; only the command definitions are pinned.
- **Commands from `CLAUDE.md`/`AGENTS.md` and space settings** are run as written, so a `make lint` named there runs the tree's Makefile, not a base copy. Editing those notes is itself flagged.
- **Includes Atrium can't resolve** (a Makefile `include $(VAR).mk`) run from the tree, and say so in a note.
- **Nested dependency folders** in a monorepo (`packages/x/node_modules`) are protected from Claude's file tools everywhere, but from shell commands and Codex only at the repo root.
- **Rust and Go checks** run under the same profile with their caches pointed at the temp folder; a toolchain that insists on writing to its home folder fails, which shows as a failing check, not a pass.
- **Python dependencies** are protected (`.venv`) but never installed by the engine.

## The reviewer

Once the checks pass (or there are none), a fresh session reviews only the diff and the brief. It knows nothing of the writer's session. The space picks the reviewer: **Auto** (the default) uses Codex, then Gemini, when one is installed and allowed in that space (private spaces and repos with `.env` files are Claude only), else a fresh Claude session; or pin one agent; or turn review off.

The reviewer judges mergeability, not style: unmet acceptance criteria, scope creep, code that doesn't match the patterns around it, missing edge cases, risky changes. Each finding comes back with a severity, `file:line` and a reason. When it asks for changes, the writer gets every finding and must fix it or explain why not against the brief, answering each one. At most two review rounds; then the work comes to you with the findings and how each was resolved. This replaces the earlier "review handoff with one fix round": there is one review mechanism, and separate fix tasks are gone (older ones end on upgrade, and the work they followed waits for you as before).

## Budgets and loop detection

Each task has a token and a time budget, with defaults by size (small 200k tokens and 20 minutes, medium 600k and 45, large 1.5M and 90). A space can set its own in Settings, and a task's can be changed from its detail. Budgets count Atrium's own work since you last stepped in: starting, retrying or giving a hint starts them over. Tokens come from what each CLI reports; when one doesn't, the count is shown as a floor.

Atrium pauses a task with a one-line diagnosis when:

- the time budget runs out, mid-run included;
- another automatic turn would go over the token budget;
- the agent makes the same edit three times in a run, or the same tool call three times in a row (it's stopped mid-run);
- the same check fails the same way twice in a row, or three turns pass without a check newly passing.

A paused task offers two ways on: **Give it a hint**, which carries on from the branch with your note, and **Explain the problem instead**, a read-only run (no edits, no commands; the branch's commits and diff are handed to it) that says what's going wrong rather than trying again.

## Where it lives

- `src/engine/brief.ts`, `brief-draft.ts`: the brief and its pre-pass.
- `src/engine/checks/`: detection, the sandboxed runs and the attention notes.
- `src/engine/loop.ts`: loop state, budgets and loop detection.
- `src/engine/handoff.ts`: the reviewer's prompt and rounds.
- `src/engine/runner.ts`: the turn, the gate and the hand-offs between stages.
