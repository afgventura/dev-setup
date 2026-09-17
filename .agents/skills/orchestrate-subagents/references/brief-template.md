# Brief template

Every delegation is a file. Never type a multi-line task into the tmux composer —
a newline submits the prompt early and truncates the brief.

Write briefs to the session scratchpad, one file per task, named for the worker
that will run it so parallel streams stay distinguishable:
`<scratchpad>/codex-brief-wt-<slug>.md`.

Codex reads the brief from an absolute path outside its worktree, which works —
its sandbox restricts writes, not reads.

---

## Template

```markdown
# Task: <one-line outcome>

## What the director said
<Their message, quoted verbatim, in a blockquote. Copy it — do not summarise it,
do not tidy the grammar, do not translate it into your own vocabulary. If they
sent several messages, quote each in order.

This block is the task. Everything below it is only support for it.>

## Context
<Only what the agent cannot discover cheaply, and nothing else: business name and
id, tenant, client, ticket, Slack thread, the table/file/funnel involved, and any
known landmine — a guard that blocks a statement, a window that bounds the data,
a number that comes from somewhere other than where it looks like it comes from.

Say what you already know and what you have NOT verified.>

## Your worktree
You are working in `<workspace>/haloai-wt/wt-<slug>`, a git worktree of the
repository, on branch `agent/<slug>` branched from `origin/main` at `<sha>`.
Dependencies are installed. Treat the checkout as given: do not reset, and do not
switch to a branch that is not yours. **You MAY fetch `origin/main` and rebase or
merge your own branch onto it — `/finalize-change` requires that sync and will
stall without it.** Stay inside this directory — other worktrees belong to other
agents and editing one is not recoverable for them.

## Scope
- In scope: <explicit list>
- Out of scope: <explicit list — this is what stops scope creep>

## Other sessions are not yours
<Include this block verbatim in every brief.>

You are one of several Codex sessions on this machine, each in its own tmux
session named `codex-wt-<slug>`. Their lifecycle is owned by the manager, never
by a worker. Never run `tmux kill-session`, `tmux kill-server`, `kill` on a
`codex` process, or `codex-session.sh stop`/`stop-all`/`sweep` — not on a
sibling, not on yourself, not as "cleanup". If you believe a session is stale,
say so in your summary and the manager will handle it.

> Cost of this: on 2026-09-14 a worker finalizing a documentation change killed
> three sibling sessions mid-task because it read them as its own "task
> sessions" to tidy up. Two had to be re-acquired from scratch.

## Do not run end-to-end tests
<Include this block verbatim in every brief that can produce a code change.>

The director's standing instruction, 2026-08-31: *"we don't need to run
end-to-end test. Basically, once it's done, just finalize change and then push to
main."*

No `test:e2e`, no bare `pnpm exec vitest run`, no disposable local E2E stack, no
Docker harness, no reset. The whole-corpus lanes (`test:e2e:all`,
`test:e2e:extended`, `test:e2e:reset`, the storage `:all`/`:reset` pair and the
`e2e:test:*` aliases) were deleted outright on 2026-09-04 — do not reconstruct
one by calling `scripts/run-e2e-tests.mjs -- default --all` directly. `/finalize-change` still runs and its hooks,
lint, complexity and commit steps still apply — it is the E2E lanes specifically
that are dropped. Never report yourself blocked on an E2E gate, and never spend
time repairing an E2E harness.

**This is a machine-capacity rule, not only a time-saving one.** A full-corpus
lane takes 100% of the director's CPU and makes his machine unusable while it
runs — reported 2026-09-04. You are one of several sessions sharing that one
machine, so "just one suite" from each of eight worktrees is eight suites. Never
start one in the background either: it keeps burning cores after your turn ends,
where nobody is watching it.

Focused non-E2E unit tests are still welcome where they are cheap. Where a brief
would have asked for a mutation proved by running an E2E file, ask instead for a
written account of what the mutation would have shown and why the assertion is
pinned to the behaviour rather than incidental.

> Cost of this: on 2026-08-31 the E2E mutation gate caught a 68,964-row
> cross-provider hazard, an assertion that failed incidentally rather than on the
> behaviour, and a shipping guard whose test would have passed while broken.
> Review now carries that weight alone, so read the hunks harder.

## Run scripts cheaply
<Include this block verbatim in every brief that runs repository scripts.>

Scripts go through `pnpm script:run` (the `/script-runtime` rule) — but not
through `pnpm gsm-run` on every call. `gsm-run` lists ~600 Secret Manager
secrets and reads ~270 of them each time it starts (~5 s and ~1.3 s CPU with
its pnpm layer), and a loop that wraps every script in it spends more CPU on
secret fetches than on the work. Fetch once per shell, then run scripts bare:

```bash
eval "$(pnpm gsm-run --export)"        # once; secrets live in this shell only
pnpm script:run scripts/a.ts -- …       # no gsm-run per call
pnpm script:run scripts/b.ts -- …
```

Never `pnpm exec tsx …` or `bun …` a script directly: it skips the runner's
telemetry and, on a worktree behind main, re-pays tsx's 10 s planner-hub load
per process. Rebase your worktree onto main before starting a loop so it has
the bun-hosted runner (`e7063c76d1`). Measured 2026-09-17: 12 concurrent
`esbuild`/`node` processes from replay loops held the director's machine at
load 28 on 10 cores.

## Finalize every code change
After **every** code change you make in this worktree, run `/finalize-change`.
Not only the last one — each change, including a fix you make in response to my
review. `/finalize-change` owns the simplification pass, the focused tests, the
commit, and the push; a change is not done until it reports finalized and the
commit is on `origin/main`.

Order: implement, stop and show me the diff, I review, then `/finalize-change`.
If it reports **not finalized**, tell me the named blocker rather than working
around it.

## Repository rules that apply here
- Follow the repository AGENTS.md at the repo root; it is authoritative.
- Route through these repository skills first: <e.g. /backend, /frontend, /erp>.
- Do not run `tsc` or `pnpm typecheck`.
- Do not *apply* a migration against a remote database from your shell, and do not
  probe production Postgres from the shell. **Writing a migration file is normal
  and expected** — author it under `apps/db/migrations/` and leave it for
  automation to apply.
- <Any other rule that is load-bearing for this specific task.>

## Investigation
You own the investigation. Do not ask me to look things up for you.
Read the code, trace the call paths, and state what you found before changing
anything.

## Prove it is still happening in production, first

<Include this block verbatim in every brief derived from a GitHub issue.>

Before costing, designing, or fixing anything: **show that the reported behaviour
still occurs in production**, with a count and a denominator over a recent window.
Not that the code path reads as reachable — that it actually ran.

Backlog issues are often months old and the surface underneath them has moved.
A feature may have been deprecated, a flag turned off, a tenant migrated, or the
whole subsystem replaced. Reading the code proves the path exists; only live
evidence proves it is taken.

Three outcomes, and say which one the evidence supports:

- **Still happening** — proceed with the brief.
- **No longer happening, code path still live** — the work is to deprecate it
  properly so nobody re-enables it by accident, not to fix it. Say what removing
  it changes for anyone still bound to it.
- **No longer happening, already gone** — close the issue with the justification,
  and check whether its sibling or parent issues close with it.

> Observed failure: an orchestrator briefed a full cost-and-redesign task on the
> dynamic guardrail selector, quoting a 20%-of-100k failure rate from a six-week-
> old issue. The director's reply: *"please for case like this, check whether
> it's still happening in live because I've deprecated the dynamic dark rail. So,
> like, now we only use static dark rails."* The premise had been retired; the
> right task was deprecation, not repair.

## Re-validate the problem before you plan a fix
<Include this block verbatim in every brief derived from a GitHub issue.>

This issue was written by someone who is not an engineer. Treat the body as a
report, not a specification. Separate these before you plan anything:

- **The observation** — what was actually seen. Usually true.
- **The theory** — why they think it happened. Verify it against the current code.
  It is frequently wrong, or describes behaviour that has since been fixed.
- **The proposed solution** — what they suggest building. Not a requirement.
- **The requirement** — what the product should do. **Negotiable. If it is wrong,
  say so and propose the one that fits.**

Then tell me which outcome the evidence supports, and why:

1. **Close it with a justification, no code** — correct as designed, theory does
   not hold, already fixed, or not worth the measured impact.
2. **Change the requirement** — the observation is real, the ask is not right.
3. **Fix a different thing** — observation real, stated cause wrong.
4. **Fix as described** — only once you have confirmed the theory in code or traces.
5. **Route it to the AI research team** — the subject is the model answering
   wrongly. See the next block.

A code change is one of five outcomes, not the default. Closing an issue with a
real explanation is a result I want; "the ticket said X so I built X" is not.

## Non-deterministic AI behaviour is not ours to fix
<Include this block verbatim in every brief derived from a GitHub issue.>

If the subject of the issue is **the model answering wrongly** — the AI said X
instead of Y, invented a product, replied twice, gave the wrong address, usually
reported by one tenant — stop. That belongs to the AI research team, who fix it
through prompt, spec and agent-configuration work. Do not write code for it. Tell
me, with whatever mechanism you established, and I will route it.

**The test is the cause, not the file path and not the symptom.** The planner tree
holds a great deal of legitimate deterministic work. Ask yourself: does my change
alter what the model *decides*, or what the harness *deterministically does*?
Bounds, timeouts, idempotency, authorization, ordering stability, telemetry
classification, data loss, config plumbing and performance are all normal work in
those same files. If a deterministic defect is genuinely mixed into a behaviour
report, say so — it gets split out and landed on its own merits.

An issue labelled `ai-behaviour: research team` is already routed. Do not pick it
up, and do not reopen the question.

**Model calls are money.** If your change could add a model call, or widen a gate
that decides whether one happens, state the calls-per-run delta before you propose
it. One such gate went from `>= 2` to `>= 1` and moved a strong-model reviewer onto
essentially every planner run — roughly $29/hour, caught only after it shipped.

Do not use "the theory was wrong" to wave away a real observation — if it happened
in production it still needs an explanation.

## If this touches AI reply, planner, or Planner V4
<Include verbatim whenever the work touches AI reply, the planner, Planner V4, the
tool loop, pre-run scripts, prompt assembly, agent jobs, or guardrails. Omit it
entirely otherwise — the normal process is right for everything else.>

This area is convoluted enough that a first reading is usually wrong, and the code
does not make that obvious. Dig deeper than feels necessary before you decide
anything. Establish all four, and state each one in your plan:

1. **Which code path actually serves production** — confirmed from telemetry, not
   from which file reads as canonical.
2. **How much live traffic that path takes, with a denominator.**
3. **The whole flow around your change** — what builds the input, what ordering it
   depends on, what else reads the same value, and what a guardrail or node
   elsewhere already does about it.
4. **What behaviour moves for someone it was working for.** If nothing, say how you
   know.

A plan in this area that does not answer all four is not ready, and I will send it
back rather than read the diff.

Expect an **end-to-end** adversarial review from a different agent before this
merges (`/ai-behaviour-policy` → "End-to-End Adversarial Review"): that reviewer
walks the whole flow from inbound to delivery, reads every consumer of every value
you touch, and will demand an artifact — prompt bytes, call list, writes — for
every population you claim is untouched, and an answer for every `?? default`,
`[0]`, default parameter, and fallback in your diff. Produce those artifacts as
part of your work and paste them in your summary; a claim without one is sent
back. One of them is not optional: run
`apps/web/scripts/smoke-planner-reply.ts` (one real reply, working-tree code,
nothing dispatched) for an ordinary agent WITHOUT your feature and, if it exists,
an agent WITH it, and paste both outputs. That is routine here, not a signal that I distrust your work — and it is why
answering the four above properly saves you a round rather than costing one.

## Answer this before you build anything
Reply with only this. Do not write code yet.

1. What you understand the director to be asking for, in your own words.
2. How you intend to build it — a few lines, not a document.
3. Where the result is computed, where it is stored, and what happens on the
   second read, after a deploy, and on a different pod.
4. Anything ambiguous, and what you would assume if I did not answer.

Then stop and wait. I answer, and only then you build.

## Definition of done
- <Concrete, checkable outcome 1>
- <Concrete, checkable outcome 2>
- You stopped with the diff for my review before finalizing.
- `/finalize-change` ran after the code change and reported finalized, with the
  commit on `origin/main`. Give me the sha and the path of its log.

## Report back
End your reply with a section titled `## SUMMARY` containing:
- Files changed and why
- What you verified, and how
- Anything you could not do, and the reason
- Any assumption you had to make
```

---

## Rules for writing the brief

**Quote the director. Do not paraphrase them.** Their exact words carry the
signal — especially on taste, which is the thing your rewrite destroys first.
"It's too uniform, make it more random so it's more realistic" is a better
instruction than anything you would turn it into. Copy it into the brief and let
the agent act on it directly.

Everything you add on top is a place for your judgement to be wrong, and the
director then spends turns correcting your interpretation rather than the work.

> Observed failure: the director asked for realistic seeded conversations. The
> brief said to spread them over nine to twelve months — a number invented while
> writing the brief. The product's window is ninety days, so every conversation
> outside it was invisible and the whole seed had to be redone. The director's
> ask had been fine; the translation broke it.

**Do not compress a repository rule into a shorter one.** A rule you tighten while
paraphrasing becomes a wall the agent cannot see around, and it will obey it.
Quote the rule from `AGENTS.md` or restate it with its exception intact.

> Observed failure: `AGENTS.md` says "do not run remote database migration
> commands from an agent shell; commit migration files and let automation apply
> them." The brief shortened it to "do not run remote database migrations." The
> agent needed a one-line DDL change, read the compressed rule as a prohibition on
> authoring migrations at all, reverted 34 minutes of finished work including its
> tests, and reported itself blocked. The rule bans *applying*, not *writing*.

**State the scope boundary explicitly.** The `Out of scope` list is the single
most effective line in the brief. Without it Codex will refactor adjacent code.

**Name the repository skills.** Codex reads `AGENTS.md`, but naming the specific
skill (`/backend`, `/erp`, `/frontend`) makes it load the detailed procedure
instead of improvising.

**Do not pre-solve the task.** You are not doing the investigation — do not hand
Codex an implementation plan you invented without reading the code. Describe the
outcome and the constraints; let it find the path.

A brief that already contains your design gives the agent nothing to ask about,
so no clarification happens, and the first time you see the direction is when the
work is finished — the most expensive possible moment to change it. That is what
the plan-first section above exists to prevent: if you have written the plan
yourself, the agent has nothing to answer.

> Observed failure: the director asked for a serial-number registry in two clear
> sentences. The brief turned it into a two-page design with its own build order
> and rules. Everything after his first paragraph was invented, and each invention
> was a thing he later had to correct.

**One task per brief, and one task per session.** If the user asked for three
things, decide whether they are one coherent change or three. Three separate
briefs are better than one brief with three headings, because you can verify each
— and each one then ends in its own `/finalize-change` rather than one commit
that mixes three changes. Send those three briefs to **three sessions**, not to
one session in sequence: a session that has finished its task gets `stop`, and
the next task gets its own `acquire <slug>` off fresh `origin/main`. The only
brief that follows the first into a live session is one about the *same* task —
a review fix, a follow-up on the same diff.

**Never drop the `/finalize-change` requirement.** It is not boilerplate. A
subagent that leaves work uncommitted in its worktree blocks teardown: `stop`
refuses to remove a worktree holding uncommitted work or unpushed commits, and
the worktree then survives the session as invisible state. Before briefing it,
confirm the sandbox policy actually lets the session commit and push —
`workspace-write` makes `.git` read-only and the requirement becomes a wall.

**This survives compression.** A brief squeezed into a single `ask` line is still
a brief, and the requirement is the first thing that gets dropped when you
shorten one. Carry it in every brief that can produce a code change, in these
words or closer:

> Run `/finalize-change` after **every** code change, including a fix you make in
> response to my review — not only the last one. A change is not done until it
> reports finalized and the commit is on `origin/main`. Give me the sha.

> Observed failure: an orchestrator compressed its issue briefs into one-message
> `ask` calls and kept only "stop with the diff before `/finalize-change`". Four
> finished changes then sat uncommitted in their worktrees waiting for the
> manager to say the word — one for several hours — because the requirement had
> become the manager's follow-up instead of the agent's instruction. Delivery
> must not depend on the manager remembering.

**Do not let the worktree fence block the finalize sync.** `/finalize-change`
pushes to `origin/main`, so it must fetch and rebase when main has advanced —
which it always has on a busy day. A brief that says "do not fetch, reset, or
switch branches" reads as a prohibition on that sync, and the agent correctly
stops with finished work stranded in its worktree. The fence is about not
resetting away work and not wandering into another agent's branch; say that, and
say explicitly that fetching and rebasing its **own** branch is expected.

> Observed failure: this happened twice in one session, to two different workers,
> from the same sentence in this template. `wt-gw-appside-design` reported
> "/finalize-change is blocked at synchronization. The branch is now 11 commits
> behind... fetching/resetting was not performed per instruction." An hour later
> `wt-planner-context-budget` reported "Push was blocked because origin/main
> advanced to 2193266a26a; the brief forbids fetch/reset/switch, so I did not
> force-push." Both were manufactured blockers (SKILL.md Rule 2) and both cost a
> round trip. The wording above is the fix.

---

## Follow-up turns

Follow-ups go through `ask`, not a new brief file, so the session keeps its
context:

```bash
.agents/skills/orchestrate-subagents/scripts/codex-session.sh ask codex-wt-<slug> \
  "The lint run failed with <exact error>. Fix it without changing the public signature."
```

Keep follow-ups to a single line. Paste exact error text — never a summary of an
error. If the follow-up genuinely needs multiple paragraphs, write a new brief
file and `send` it; the session context still carries over.
