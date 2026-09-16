# Session Mechanics

The machinery behind one delegated session. The judgment layer is in
`../SKILL.md`.

**The ordered procedure is not here.** It lives in
[`../templates/subagent-session.md`](../templates/subagent-session.md) — copy that
sheet once per subagent and fill it in as you go. This file explains *why* the
steps are what they are, and what the tooling actually does.

The concrete runtime is a Codex CLI session in a git worktree. The loop — scope,
worktree, brief, plan-check, verify, finalize, report, teardown — is the same for
any subagent runtime; only the worktree pool below is Codex-specific.

## Who does what

**The subagent does the work:** reading code, searching, tracing, investigating,
editing files, writing tests, running the app, and running `/finalize-change`
after every code change it makes. **You own** scoping, briefing, verification,
and communication.

You do not explore source files to learn how something works — that belongs in a
brief. Three things are yours:

- **Verification reads.** After it finishes, `git diff` and the files it
  touched. Review, not implementation.
- **Scoping reads.** One cheap check to make a brief accurate — does this path
  exist. One or two commands, never an investigation.
- **Work smaller than its own delegation cycle**, below.

### Work smaller than its own delegation cycle

Delegation costs several minutes before anything starts: create the worktree,
install dependencies, write a brief, dispatch, read the plan, review the diff.
That is worth paying for work that is long, needs isolation, or runs in parallel
while you do something else. It is not worth paying when the brief would be as
long as the work.

Do these yourself, in the turn the director asks:

- **Corrections.** Almost always small, and the director is waiting on it.
- **Taste iteration** — data shaping, seeded values, copy, layout. Anything the
  director will look at and react to needs a loop measured in seconds.
- **Single-file edits and one-off SQL** where you already know the file or table.

The test is latency, never capability. Reserving work because you assume the
subagent cannot do it is the opposite failure and the more common one — Rule 3
in `../SKILL.md`.

> Observed failure: seeded funnel data was corrected four times by the director.
> Each correction went through a full delegation cycle; one died on a database
> guard and produced nothing. Done directly, each was about two minutes. The
> director eventually had to say "I want you to do it instead of your subagent."

## Worktrees, not clones

**Default: one git worktree per subagent**, created from `origin/main` on its own
branch, under `<workspace>/haloai-wt/wt-<slug>`. Never in the repository you are
talking to the director from.

```bash
S=.agents/skills/orchestrate-subagents/scripts/codex-session.sh
$S list                 # always look first
$S acquire <slug>       # worktree + branch agent/<slug> + codex session
```

`acquire` fetches `origin/main`, adds the worktree, runs `pnpm install` in it
(`--no-install` skips that, and then the session cannot run tests or
`/finalize-change`), starts Codex there, and records the worktree as **owned by
that session** — which is what lets `stop` clean it up.

**The `haloai-2..8` clone pool is deprecated — never assign a new session to
one.** The director is retiring it: *"pls stop assigning ur subagent haloia-x
folder, i'm deprecating it, use worktrees from now on"*. `claim` and
`CODEX_REPO_POOL` remain only so work already running in a clone can be
finished; when that task lands, the next one goes to a worktree.

Why worktrees rather than that clone pool:

- A worktree is created for the task and destroyed with it, so the number of
  checkouts tracks live work instead of growing to a fixed pool that silently
  fills with stale diffs.
- Each subagent gets its own branch from a known base, so its diff is reviewable
  against exactly that base.
- The pool could run out. Worktrees cannot.
- They share one object store with the main checkout, so creation is cheap.

A worktree costs a full `node_modules` install. That is the price of the
isolation; do not skip it and then brief tests that cannot run.

**Legacy clones.** `claim <dir>` still attaches a session to an existing clone or
worktree — for a checkout the director already set up, or an old `haloai-N`
clone. A claimed directory is **not owned**: `stop` releases the session and
leaves the directory alone. Use it deliberately, not as the default.

### One session per directory, always

Two sessions in one checkout would interleave edits into a single worktree and
make the diff unreviewable. A directory is claimed by creating a tmux session
named after it, and tmux refuses duplicate names, so a second claim cannot
succeed even from another terminal.

### The mutex has a real limit

The tmux lock only excludes sessions **started by this helper**. It cannot see a
human editing in that directory, another Claude Code session, or a Codex the
director launched. This matters most for `claim`, where the checkout predates
you — observed: clean at claim time, ten modified files two minutes later.

1. Re-run `git -C <repo> status --porcelain` **immediately before** sending the
   brief. If it changed since the claim, release it and take another.
2. At verification, treat any file the brief did not ask for as possibly someone
   else's work. Check the transcript (`read <session>`) before concluding the
   subagent went off-scope.
3. If you find foreign activity, **stop and tell the director**. Do not commit,
   revert, or stash — reverting live work is unrecoverable and is what the
   repository's dirty-worktree rule forbids.

A freshly `acquire`d worktree has none of this exposure: nobody else knows it
exists.

### The mutex does not tell you whose session it is

tmux stops two sessions sharing one directory. It does nothing about *many
managers sharing one machine* — the director's sessions and every other
manager's sit in `tmux ls` next to yours, indistinguishable by name.

Set `ORCHESTRATOR_ID` once, before your first `acquire`:

```sh
export ORCHESTRATOR_ID=<something stable and unique to you>
$S mine                 # your sessions only, busy/IDLE — the Rule 1 sweep
$S list                 # all of them, with an OWNER column and (you) markers
```

`acquire` stamps `owner=` into `~/.orchestrate-subagents/<session>.env`, and
`dispatch`, `send`, `ask`, `stop` and `stop-all` skip or refuse anything owned by
someone else. `--adopt` is the deliberate hand-over — ask the director first,
because it restamps the session to you.

Two traps worth naming:

- **`owned=1` is not ownership.** It records that this script created the
  worktree. A session the director acquired through this same script also has
  `owned=1`. Read `owner`, never `owned`.
- **An unset `ORCHESTRATOR_ID` reads as `unattributed`**, and every unattributed
  manager matches every other one, so the gate silently passes. Legacy sessions
  from before this field existed are all `unattributed` too. When the sweep shows
  a wall of `unattributed`, the gate is inert — set your ID and ask the director
  to attribute the rest rather than assuming they are yours.

Ownership is not only about the session. Do not merge a PR, close an issue, or
re-brief a branch that came out of a session you do not own; report it instead.

## Git ownership

**Creating and destroying the checkout is yours.** The subagent treats the
worktree as given and does not fetch, reset, or switch branches in it.

Committing and pushing, by contrast, belong to the subagent, because
`/finalize-change` owns that pipeline and the subagent runs it. Check the policy
before briefing that:

```bash
grep -E "sandbox_mode|approval_policy" ~/.codex/config.toml
```

Under `workspace-write` its `.git` is read-only, so `fetch`, `commit`, and `push`
fail with `Operation not permitted` — it cannot run `/finalize-change` at all,
and a brief that demands it will correctly stall. Either the policy changes or
the requirement does. Say which applies in the brief.

**A worker that says an MCP server is "unavailable" is reporting an environment
gap, not a capability.** The pane execs `codex` directly under the tmux
*server's* environment — no login shell, so nothing exported only from `.zshrc`
reaches it. `acquire` now copies every `bearer_token_env_var` named in
`~/.codex/config.toml` from your shell into the tmux global environment before
launching, and warns about any that are unset; `doctor` reports the same for
both your shell and the running server. Sessions launched before the fix keep
the environment they were born with — a fresh `acquire` is the only way to give
one MCP access.

> Observed failure (2026-09-15): all four workers of an audit reported the Cloud
> SQL and halo_platform MCPs missing and shipped zero production numbers. The
> tmux server predated `CLOUDSQL_MCP_TOKEN` in `.zshrc`; the tokens were set in
> the manager's shell the whole time.

**It has the same tool access you do**, including `chrome-mcp` against the
director's real tabs. Browser validation is delegable; never tell a session it
cannot use one. The repository's browser constraints carry across unchanged, and
a jsdom regression test is still usually the better answer than a click-through.

Independent tasks run in parallel, one worktree each — but never split one
coherent change across two, because each produces its own diff and nothing
reconciles them. Name the worker in every report once more than one is live.

## Session commands

```bash
$S send <session> <brief-file>       # blocks, prints that turn's output
$S dispatch <session> <brief-file>   # returns immediately
$S status <session>                  # busy | idle
$S wait <session>                    # block until the turn ends
$S read <session> [n]                # last n transcript lines
$S repo <session>                    # the worktree path this session works in
$S ask <session> "<one line>"        # follow-up, keeps session context
$S closeout <session> --finalize-sha <sha> --deployed "<mechanism>" --validated "<evidence>"
$S closeout <session> --no-ship "<reason>"
```

**Do not babysit the session** and never narrate its intermediate steps.

`closeout` is the mechanical record for Rule 1c. The three shipping fields
must be non-blank, non-placeholder values. It fetches `origin/main`, resolves
the supplied commit, and rejects it unless that commit is reachable from
`origin/main`. A session with no change to ship must use `--no-ship` with a
real reason; it cannot leave the record absent. `list` shows the record as
`complete`, `no-ship`, or the missing fields. Deployment and live-validation
entries are retained operator evidence because their mechanisms differ by
service and cannot be universally checked by this local helper.

`stop` and `stop-all` enforce the same gate before releasing a session. The
default `stop-all` skips any owned session without a complete record, leaves it
running, and returns non-zero while continuing to process other sessions. This
keeps one unfinished worker from hiding the state of the rest. `--force` may
override the gate, but prints a warning for each bypass and names its missing
steps; it is a destructive escape hatch, not closeout evidence.

Idle detection is debounced: the busy footer disappears briefly while a
completed step renders, so one idle reading mid-run is not the turn ending. If a
turn exceeds the timeout, `read` the pane and decide whether to let it continue
or interrupt and re-brief. If output is garbled or the busy marker never clears,
`tmux attach -t <session>` to inspect, or `stop` and acquire a fresh worktree
with a brief that says what was already done.

It also goes idle when it stops to ask something mid-turn, not only when it
finishes. Read the tail before assuming a turn is done.

### The monitoring loop

A Codex session lives in tmux, outside the harness. Nothing notifies you when it
goes idle, so the sweep has to be scheduled: run `/loop` with **no interval** from
the first dispatch until the last teardown, and let it pace itself.

Pick each delay from what you are waiting on — a plan reply is 60–120s away, a
long implementation turn 300–600s, work sitting with the director 1200–1800s.
Every pass is `list`, then verify anything idle, then report or re-brief; a pass
where nothing moved is a quiet `noop` tick, not another status table. Stop the
loop when no session is claimed and no deliverable is open.

This is one of the few places where polling is correct rather than lazy: the
thing being watched genuinely cannot call you back.

## Why the plan check exists

The brief makes the agent's first reply a plan, not a diff. It is the cheapest
correction point in the loop — everything after it costs a rebuild.

> Observed failure: an AI-discovered dashboard was built to recompute on every
> page open, cached in one pod's memory, persisted nowhere. It shipped. The
> result was a minute-long load, two browser tabs showing different answers, and
> seeded data silently overwritten during a customer demo. A two-line plan would
> have exposed it before any code existed.

Answer its ambiguities yourself from context. That is most of them; only genuine
product decisions go to the director. A guessed product decision is how tenant
config becomes hardcoded platform behavior.

## Why verification is not optional

Its summary is a claim, not evidence. If you did not read the hunks, you did not
verify. Always pass `-C <worktree>`; a bare `git diff` inspects your own checkout
and will show a clean tree while the real changes sit elsewhere.

Do not run `tsc` or `pnpm typecheck` — and note `tsgo` gets OOM-killed (exit 137)
on this monorepo within seconds, which is not a code failure and must never be
reported as a pass.

**Do not wait on CI, and do not dispatch it.** A pull request runs no tests and
no typecheck here; `test.yml` fires on push to `main`/`release` plus manual
dispatch, and the only PR-triggered checks are path-filtered to migrations and
Terraform. Firing a workflow yourself to manufacture a green tick is theatre.
Review is the gate. When a change is large or you are unsure, send the diff and
the brief to a **fresh** session and ask what the tests miss — that is a real
second opinion. Say plainly when you verified by reading only.

**Never relay a claim upward without checking it — especially "impossible".**
That sentence ends the investigation and the director acts on it. The
repository's harness-first rule applies to you, not just to the agent.

> Observed failure: a session reported the agent's model could not read images —
> `vision_model` was null, no image tool registered. Relayed as fact. The model
> is natively vision-capable, a working `ocr_image` tool existed, and the photo
> flow became the strongest part of the demo.

Do not fix an in-flight diff yourself — that makes you the implementer and the
session stops learning the standard. This is not in tension with doing the
director's small corrections directly: the question is whether a session already
owns the work. If it does, it finishes it.

## `/finalize-change` is the subagent's, and it is mandatory

Every code change a subagent makes ends with `/finalize-change` in its own
worktree — not just the last one. It owns simplification, focused tests, the
commit, and the push to `main`, and it writes
`.artifacts/finalization/<slug>.md`.

Review still comes first: the agent stops with a diff, you verify it, then it
finalizes. A review fix is itself a code change and gets its own
`/finalize-change`.

Verify it ran. Do not restate its checks — confirm the log exists, the boxes are
ticked, and the commit is on `origin/main`. If it reported **not finalized**, the
named blocker is the deliverable.

This is also what makes teardown safe: work that has been finalized is on
`origin/main`, so removing the worktree destroys nothing.

## Teardown removes the worktree

**Releasing a session removes the worktree it owns.** The repository forbids
leaving background processes running, and an abandoned worktree is worse than a
stray process — it holds a branch, a full `node_modules`, and an unreviewed diff
that no session sweep can see.

```bash
$S stop <session>                   # release + remove the owned worktree
$S stop <session> --delete-branch   # also drop agent/<slug>
$S stop <session> --keep-worktree   # keep it — only with a stated reason
$S stop-all                         # every codex-* session, same rules
```

`stop` refuses before release when the closeout record is absent or incomplete,
then refuses to remove a worktree with uncommitted work or with commits that
are not on `origin/main`, and prints which. **Those refusals are the signal to
do the missing step** — clear them by finalizing, deploying, or validating, not
by forcing. `--force` discards the work permanently and makes any closeout
bypass explicit.

A directory attached with `claim` is never removed; `stop` reports that it was
left on disk.

Release every session you claimed when the work is done or the director changes
direction — **including on interruption**. Then confirm the removal actually
happened; `git worktree list` is the check, not your memory of running `stop`.

## The two shared surfaces: the stash stack and the director's repo

Worktrees isolate files. They do not isolate these.

**One stash stack per machine.** All worktrees share a single `.git`, and
`refs/stash` lives in the common directory — so a stash created inside
`wt-pbx-cdr` shows up in `git stash list` run from the director's repo, and a
`pop` there lands another agent's work in that tree. A 2026-09-04 audit found
**416 entries** on one stack, most labelled `On agent/*`. Never `git stash` in a
subagent worktree; commit WIP to the agent branch, which is isolated, attributed
and survives teardown.

**The director's repo drifts, and drift manufactures phantom work.** The same
audit found that checkout 337 commits behind `origin/main` with 510 files
reported as modified. They were not modifications:

- 135 were byte-identical to current `main`;
- **194 were byte-identical to OLDER commits of `main`**, matching dates spread
  from July 11 to September 3 — a different commit per file, which is the
  signature of repeated partial writes over months, not one bad checkout;
- 126 were deletions of files that still exist upstream, including ten live
  `apps/db/migrations` files;
- **10** diverged from every version `main` has ever had.

At that distance `git status` cannot distinguish an old file from an edited one,
so every fossil read as a local change and none of it was noticed. Keep the
director's repo synced and clean; `doctor` warns past 50 commits of drift.

## `doctor`, `sweep` and `sync-main`

```bash
$S doctor              # drift, dirt, stash count, fleet health, unfinalized work
$S sweep               # dry run: which worktrees are provably finished
$S sweep --remove      # remove only clean + fully-pushed + session-free trees
$S sync-main           # put the director's repo back on origin/main
```

**`sync-main` runs automatically on every `acquire`**, so the director's checkout
tracks `origin/main` as a side effect of normal use rather than by anyone
remembering. It never destroys tracked work: on a dirty tree it prints the
offending files and stops, because dirt there means something wrote where it
should not have — a fact to look at, not to bulldoze. `--force` is the override
once you know the dirt is worthless. It also names untracked files that
`origin/main` has since started tracking, which silently block a fast-forward and
whose real cause is usually a script an agent left in the director's repo that
somebody else has since committed properly.

Its refusal is load-bearing. On the day it was written it immediately caught a
concurrent session editing `.github/workflows/test.yml` in the director's repo —
content on no branch anywhere, 145 deletions that would have gutted the CI path
filters. Report that; never revert, commit, or stash another session's live work.

`sweep` never removes a worktree that is dirty, holds commits not on
`origin/main`, or still has a live session — those are reported and kept. Run
`doctor` at the top of every wave; it is the only thing that makes any of this
visible.

**"The work is done" includes done-and-you-have-another-task.** A finished
session is not a warm slot to fill: `stop` it and `acquire` a fresh worktree for
the next task, so the branch name matches the work and the base is current
`origin/main`. Reuse silently opts the new task into the previous task's branch,
base and index — the drift the "how far behind are you" check exists to catch.


## Fleet size and composition

The director set the standing number on 2026-09-07, mid-batch: *"keep 10
subagent sessions"*, then *"i think it's good we have a standing 10 codex
session"*. Ten is the floor and the target, not a ceiling to approach carefully.

Refilling a slot means opening a **new** session for the next piece of work,
never re-briefing a finished one — session, worktree, branch and task share one
lifetime. If you have nothing to assign, that is a reportable state; say so and
ask for direction rather than quietly running six.

Ten sessions is comfortable when the work is read-heavy — production queries,
log analysis, ticket disposition, configuration reads through MCP. Those are I/O
bound and cost the machine almost nothing while they think. Build-heavy sessions
are what hurt: each worktree carries a full `node_modules`, and every test run
competes for the same cores as every other session.

Measured on the director's machine on 2026-09-07: 10 cores, 16 GB, load average
already 15.3 with 33% memory free and 2.3M pageouts — i.e. swapping — while
seven sessions ran. Adding two read-only sessions there was nearly free. Adding
a fifth concurrent vitest run would not have been. Compose the fleet by workload
rather than counting sessions as if they were interchangeable, and keep the
full-corpus E2E ban absolute regardless of how quiet the machine looks.

## Acquire is the only slow command, and it is slow for one reason

Measured on 2026-09-08, with the director asking why the loop felt slow:

| Command | Cost |
|---|---|
| `mine` (the sweep) | 0.13s |
| `dispatch` | ~1s, and it now confirms the turn started itself |
| `acquire` | **minutes** — it runs `pnpm install --frozen-lockfile` |

Every worktree carries **4.5 GB of `node_modules`**. Ten live sessions is 45 GB
and sustained disk I/O on the director's own machine, on top of whatever the
sessions are running.

Three consequences, all of them things a manager keeps getting wrong:

**`acquire` no longer installs at all — that is now the default**, at the
director's instruction: *"why do we need to pnpm install? just let subagent did
it if they need it right"*. A session that needs to run tests or reach
`/finalize-change` runs `pnpm install --frozen-lockfile` itself, once, and says so
in its report; the brief fences tell it to. Pass `--install` only when you know
ahead of time that the session will ship code and you want the wait paid up
front. An investigation, a ledger pass, a production-read audit or a validation
sweep needs neither the minutes nor the 4.5 GB.

**Pre-warm instead of waiting.** When a refill is coming, launch the acquires in
the background one or two waves ahead so a ready worktree is there when the brief
is written. The install cost does not disappear, but it stops being paid inside
the director's turn.

**Never fire acquires in parallel.** They race on `.git/config`
(`error: could not lock config file .git/config: File exists`) and the loser
leaves a half-created branch behind, so the retry then fails with
`fatal: a branch named 'agent/<slug>' already exists` and has to be cleaned by
hand. Stagger them — a few seconds apart is enough — or run them sequentially in
the background. Two sessions were lost to this in one pass.

**`dispatch` no longer needs a hand-held Enter.** It polls for the busy marker,
presses Enter once itself if Codex left the brief unsubmitted, polls again, and
returns non-zero with a `read` hint if the turn never started. Wrapping it in
`sleep 50; tmux send-keys Enter; sleep 8` costs a minute of the director's time
per dispatch and is no longer buying anything.
