# Why Atrium works the way it does

Atrium's design follows what published studies and engineering write-ups say about coding with agents. This is a short summary of that evidence and the design choice each finding led to. The numbers are the sources' own; where a source is a first-party write-up rather than a controlled study, it says so.

## Most failures come from the spec and the check, not from too few agents

- **MAST** (Cemri et al., NeurIPS 2025) annotated more than 1,600 traces from seven multi-agent frameworks. About 44% of failures traced to specification and system design (ignoring the task spec, repeating steps, not knowing when the task is done) and about 24% to weak or missing verification. [1]
- **METR** had maintainers review agent pull requests that already passed SWE-bench's automated tests. Roughly half would not have been merged. [2]

So every task in Atrium starts from a **brief** with acceptance criteria and a check, Atrium **runs the repo's checks itself** after every turn instead of trusting an agent's "tests pass", and a **fresh reviewer** reads the diff for mergeability before it reaches you. See [the loop](loop.md).

## One writer is the right default

- **Google Research**'s controlled study, in its first version, tested 180 agent configurations: centralised coordination gained about 81% on parallelisable tasks, while multi-agent variants lost 39–70% on sequential ones, and independent agents amplified errors 17.2× (a central orchestrator, 4.4×). The paper's later revision widens the study to 260 configurations and drops the error-amplification figures. [3]
- **Anthropic**'s multi-agent research system beat a single agent by 90.2% on breadth-first research, at about 15× the tokens of a chat, and Anthropic notes that most coding has fewer truly parallel parts than research. (First-party write-up.) [4]
- **Cognition** reversed its "don't build multi-agents" advice only for setups where writes stay single-threaded, and reports that a reviewer with no shared context finds real bugs the writer stopped seeing. (First-party write-up.) [5][6]
- **Debate or Vote** (Choi et al., NeurIPS 2025): independent samples plus selection account for most of what multi-agent debate gains. [7]

So Atrium runs **one writer** by default, uses **read-only scouts** for breadth, offers a **split** only for independent parts on separate branches, and **best-of-N** only for uncertain work the checks can judge, always on your click.

## Tokens: cache, route, and don't fan out

- Prompt-cache reads cost a tenth of fresh input or less, depending on the model, and only a stable prefix hits the cache. [8]
- Anthropic's **advisor** pattern (a cheaper model doing the work, a stronger one consulted at hard moments) scored 2.7 points higher on SWE-bench Multilingual at 11.9% lower cost. (First-party write-up.) [9]
- Sampling several attempts, discarding those that break the regression tests and picking among the rest with a scoring model raised Claude Sonnet 4.5 from 77.2% to 82.0% on SWE-bench Verified, at several times the tokens. [10]

So Atrium keeps a writer's Claude session warm within the cache window, puts what doesn't change first in every prompt, runs briefs, scouts and explanations on a **cheap model** and review on a **strong** one, and shows each task's tokens and a list-price estimate.

## People learn when they ask why, and misjudge their own speed

- In **Anthropic's randomized study** of 52 developers learning a new library with AI help, those who generated code and then asked for an explanation scored 86% on a follow-up quiz, against 39% for pure delegation, for about four and a half extra minutes. Iterative AI debugging (handing errors back to the AI again and again) scored lowest, at 24%. [11]
- Cognitive-forcing designs (decide first, then see the answer) reduce over-reliance on AI, but people dislike them, so they have to stay light and optional. [12]
- **METR**'s 2025 trial found experienced developers were 19% slower with early-2025 tools while believing they were 20% faster. [13]

So Atrium adds a **walkthrough** to each result, **explain this hunk** on any change, an optional **predict-then-reveal** question, and the **diagnosis first** when an agent is stuck, none of them a gate. Its **director retro** is built only from measured numbers, never from how a task felt.

## Short, human-curated project notes beat generated ones

- An ETH Zürich study of repository context files found, in its first version, that generated AGENTS.md files slightly lowered success and raised cost by over 20%, while human-written ones helped only marginally (about 4%). Its later revision concludes that context files of either kind don't generally improve task success. [14]

So Atrium never writes a CLAUDE.md wholesale. It proposes one line at a time, about something the agent got wrong in your repo, and only your click commits it.

## Sources

1. Cemri et al., "Why Do Multi-Agent LLM Systems Fail?", arXiv 2503.13657, NeurIPS 2025. <https://arxiv.org/abs/2503.13657>
2. METR, "Many SWE-bench-Passing PRs Would Not Be Merged into Main", 2026-03-10. <https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/>
3. Google Research, "Towards a science of scaling agent systems", blog 2026-01-28, and arXiv 2512.08296 v1 (the figures above; later versions revised them). <https://arxiv.org/abs/2512.08296v1>
4. Anthropic, "How we built our multi-agent research system", 2025-06-13. <https://www.anthropic.com/engineering/multi-agent-research-system>
5. Cognition, "Don't Build Multi-Agents", 2025-06-12. <https://cognition.ai/blog/dont-build-multi-agents>
6. Cognition, "Multi-Agents: What's Actually Working", 2026-04-22. <https://cognition.com/blog/multi-agents-working>
7. Choi, Zhu, Li, "Debate or Vote: Which Yields Better Decisions in Multi-Agent LLMs?", arXiv 2508.17536, NeurIPS 2025. <https://arxiv.org/abs/2508.17536>
8. Anthropic, prompt caching documentation, read 2026-11-15. <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
9. Anthropic, "The advisor strategy", 2026-04-09. <https://claude.com/blog/the-advisor-strategy>
10. Anthropic, "Introducing Claude Sonnet 4.5", 2025-09-29. <https://www.anthropic.com/news/claude-sonnet-4-5>
11. Shen and Tamkin, "How AI assistance impacts the formation of coding skills", Anthropic, 2026-01-29; arXiv 2601.20245. <https://www.anthropic.com/research/AI-assistance-coding-skills>
12. Buçinca, Malaya, Gajos, "To Trust or to Think: Cognitive Forcing Functions Can Reduce Overreliance on AI", CSCW 2021. <https://doi.org/10.1145/3449287>
13. METR, "Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity", 2025-07-10. <https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/>
14. "Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?", arXiv 2602.11988, 2026 (v1 for the figures; the current version for the revised conclusion). <https://arxiv.org/abs/2602.11988v1>
