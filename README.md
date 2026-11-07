# Atrium

A calm command center for your AI agents, on your Mac.

You tell Atrium what you want in plain words. It hands the job to an AI agent,
shows you what came back, and waits for your yes before anything counts. Code,
errands, texts, investing and money all live in one place.

![Atrium's home screen](docs/screenshots/home.png)

## What it's for

**Everyday life.** Ask for a week of groceries under $80, a packing list for
Montreal in December, or help deciding what to focus on this week. You get back
a list, a plan or a file you can open in Finder.

**Texts.** Say "text mom happy birthday" and Atrium writes the message and
finds her number in your Contacts. You see exactly who it's going to and what
it says, and nothing is sent until you press Send.

![A text waiting to send](docs/screenshots/send.png)

**Work and side projects.** Describe something like "keep my job search
organized" and Atrium sets up a space with a few starter tasks. It can turn
notes into a study guide or draft an email for you to copy.

**Code.** Point it at a repo and ask it to fix a bug or review your latest
changes. Agents always work on their own branch, so your checkout is never
touched, and you review every change before it's kept. Starting a new project
creates the GitHub repo too, after you say yes.

**Investing.** See your portfolio in Canadian dollars with today's change. US
stocks are live, and TSX stocks update during market hours. Any stock or ETF
has a page with its chart, earnings date and news. You can keep watchlists, set
price alerts, and ask questions like "how much of my portfolio is tech?" Claude
answers from your real holdings. It's analysis, not advice.

![Portfolio](docs/screenshots/portfolio.png)

![A stock's page](docs/screenshots/symbol.png)

**Money.** Import a bank or card CSV to see spending by category, recurring
charges and anything unusual. Then just ask: "what did I spend most on last
month?"

![Money](docs/screenshots/money.png)

## How it works

Your work is organized into **spaces**, like a repo, school, investing or a
trip. Each space has **tasks**, and each task goes to an agent: Claude on your
Claude subscription, or Codex and Gemini for some code work.

Anything that needs you waits in **Needs you**: finished work, texts ready to
send, or a question. If an agent couldn't do something, it says so rather than
pretending it's done. **Activity** keeps a short, day-by-day history, and every
task shows the files it made.

You can use Atrium as a Mac app, in the terminal (type `atrium`), or in your
browser (`atrium open`).

## Privacy and safety

Everything runs on your Mac, and your data stays there. Agents work inside a
sandbox: they can't read your passwords or keys, can't control your other apps,
and can't change Atrium itself. Only Atrium sends texts or creates repos, and
only after you approve. Private spaces like Investing and Money only ever use
Claude, and market data services only see ticker symbols.

Archive a space to hide it, or delete it for good by typing its name. Deleted
folders go to the Trash, and your real repos and GitHub are never touched.

## Setting it up

You'll need a Mac, [bun](https://bun.sh), and the Claude Code CLI signed in to
your Claude account.

```sh
bun install
bun link             # puts `atrium` on your PATH
atrium install       # starts Atrium now and at every login
atrium app install   # adds Atrium.app to ~/Applications
```

For investing, add a free Finnhub key in **Settings → Market data**. You can
also add an optional Alpha Vantage key for official TSX closing prices. Then
import your Wealthsimple holdings report from **Investing → Portfolio**.

## For developers

```sh
bun test ./tests/engine   # run tests in groups: engine, server, dashboard,
bun test ./tests/server   # e2e, tui, mac, copy, cli.test.ts, main.test.ts
bunx tsc --noEmit
ATRIUM_DEV=1 bun src/main.ts
```

The design and build history are in [`docs/`](docs/README.md).

## License

[MIT](LICENSE)
