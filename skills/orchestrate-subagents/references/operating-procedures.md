# Operating Procedures

The workflows Gery repeatedly imposes, reconstructed from 1,822 procedure
exchanges and his observed command sequences.

**Observed usage:** `finalize-change` 530×, `axiom-tool-loop-replay` 123×,
`loop` 100×, `query-scale` 34×, `testing` and `validate-production-change` 26×
each. Dominant chain: **`axiom-tool-loop-replay` ⇄ `finalize-change`**, 142×
each direction same-day. Then `finalize-change → validate-production-change`
(50×).

## A. AI-behaviour change

1. Find and export the **real production span**. Never a synthetic case.
2. **Baseline pass rate before touching anything.** *"do
   $axiom-tool-loop-replay to get baseline pass rate."*
3. Modify the exported span **directly**. He killed the system-append override:
   *"remove this harness of system append etc, it promote a bad pattern... export
   the span and modify it directly. If we need a systematic find and replace,
   then use regex."*
4. **Validate the instrument.** *"We're wasting time, pls report to me result
   where u've already eliminated harness issue."*
5. Run n=10. Bar is **10/10**.
6. **Classify every failure** as agent / fixture / judge / harness error before
   editing a spec: *"if a failure is done in harness/fixtures then it's worthless
   to iterate thru agent spec."*
7. Ship, then re-sample production and compare to the baseline.

Prefer a structural fix (schema, action definition, node) over prompt wording.

### Why this is routed away, and the cost trap inside it

> Observed failure: #15864 was "the AI sent duplicate replies and claimed it sent
> an invoice that does not exist" at two named tenants. It was treated as an
> engineering bug. The fix widened the gate deciding whether a **strong-model**
> completeness reviewer runs, from `>= 2` inbound messages to `>= 1` — moving it
> from multi-message runs onto essentially every planner run. It cost roughly
> **$29/hour** (`9f4d4faaff`, reverted by `469bc20218`), the director caught it
> rather than the manager, and the manager's own first hypothesis about the cause
> was wrong.

Before changing any gate that decides whether an extra model call happens, compute
the call-volume delta first. That episode is also why cost is a review dimension
rather than an afterthought: a diff that adds a model call on a hot path needs its
calls-per-run delta stated before it ships, the way a query change needs its plan.

## B. Ship and closeout — `/finalize-change`

His universal "close it out" verb and most-used skill by 4×.

1. Simplification pass over new code (`/finalize-change` step 2).
2. Focused tests. He trimmed the final full-suite rerun himself: *"I don't think
   we need the one final full-suit runs after the previously failing cases passed
   individually."*
3. New commit, not an amend. Push to `main`.
4. **Deploy.** Merging is not shipping. Name the mechanism that carries the change
   to production; batching several changes into one promotion is fine.
5. `/validate-production-change` with evidence, not elapsed time.
6. **Link the GitHub issue and close it** — his single most-repeated closeout
   instruction — and tell the reporter, **after** step 5, never before.

Before teardown, record the completed gate through the session tool:

```bash
$S closeout <session> --finalize-sha <commit-on-origin-main> \
  --deployed "<deployment mechanism>" --validated "<live evidence>"
```

For work with no change to ship, use `$S closeout <session> --no-ship
"<reason>"`; a blank or placeholder record cannot satisfy `stop` or
`stop-all`. `--force` is a loud destructive bypass, not closeout evidence.

7. Screenshot for anything user-visible: *"$finalize-change where is the
   screenshot?"*
8. Terraform: final full-root plan shows zero drift.

Steps 4-6 are Rule 1c in `SKILL.md`, and the order is the whole point. Two
failures produced it:

> An appointment-attendance crash was reported "done — merged" while the fix sat
> on `main`. Prod deploys trigger on a push to `release`, so the crash stayed live
> for **29 hours** while CS believed they were recording attendance.

> An ad-attribution filter was approved on a code read, marked shipped, its issue
> closed and its worktree torn down — with no run against real data. The reporter
> found it broken in production. Reviewing the diff harder would not have caught
> it, because the diff was plausible; step 5 would have.

A passing test proves the code does what its author thought. It never proves the
author understood the production behaviour, which is why step 5 cannot be ticked
from a green suite.

He sweeps for loose work routinely: *"check what is our uncommited change, we
should $finalize-change."*

## C. Root cause before fix

He blocks a proposed fix until the mechanism is proven — *"why does the problem
mentioned in the github issue appears?"* "It works now" is never sufficient.
State findings as proven or inferred; never present inference as proof.

## D. Staged rollout

*"ok let's turn it to 1 percent and then monitor"* → verify in prod → *"then we
can increase percentage from 1% to 10%."* Feature-toggle one business before any
global flip: *"why don't u toggle it for this business first?"*

## E. Backfill and data repair

1. Export both sides to CSV and hand-match before writing: *"just check one by
   one the csv using ur eyes and then backfill."*
2. Back up before mutating history.
3. Verify counts round-trip: updated / read-back / mismatches = 0.
4. **Local, not Cloud Run**, for bounded work: *"only for 26 and not something
   that we'll use, definitely not Cloud Run... Otherwise, just don't. Do it
   locally."*

## F. Data-fix vs code-fix

Historical wrong state → fix the data, leave live logic alone. Live defect → fix
the code. Either way, sweep: *"ok pls do data fix and then check for any other
affected workflow."*

## G. Agent-spec v3→v4 migration

Always clone, never convert in place (*"pls ensure we work on a clone agent"*).
Copy the existing suite and fixtures byte-for-byte before regenerating so the
comparison is apples-to-apples. Fix fixtures at the source. Iterate until v4 ≥
baseline / ≥ 95%.

## H. Propose before implementing

On anything ambiguous: *"Can u propose first?"* / *"do not directly update the
skills. Let's just propose a new flow."* He answers point-by-point in a numbered
list — keep proposals numbered so he can.

## Mandatory preconditions

- Scope classified (tenant vs platform) before code.
- Configuration surface checked before code.
- Local verification before prod: *"I don't want to publish any change in prod
  before this."*
- Never mutate another tenant or agent without asking.
- Reliability math before any validator: *"The only reason why we add that
  validation is for case where when it doesn't have that validation the success
  rate becomes 0%"*, and *"fail-fast validation should be on the pre-commit and
  pre-push stage, not on the freaking runtime."*
- New domain layers get e2e tests on a **real local DB with zero mocking** —
  repeated near-verbatim dozens of times.

## Tool routing he enforces

`/query-scale` reflexively before ad-hoc prod SQL. `/axiom-tool-loop-replay` as
the instrument for "did behaviour actually change". `cloud-sql-mcp` not
`chrome-mcp` for control-plane writes. `gh` CLI over browser. Local over Cloud
Run for bounded work. Remote CI docker, never local orbstack. Export-then-script
over repeated `jq`. Convert one-off scripts into durable primitives: *"ensure
that our mcp have all the thing that we need so we don't need to maintain a
script like this."*

Relapsing on a corrected tool choice is a strong negative signal.

## Keep a ticket ledger, and count from it

When a batch spans more than a handful of tickets, open
`.artifacts/orchestration/<batch>-ledger.md` in the **director's repo** — not in a
worktree, whose `.artifacts/` dies at `stop` — with one row per ticket:

| Ticket | Client | Symptom | Subagent | Verdict | Pulse status | Next action |

Add the row when the subagent is **dispatched**, not when the ticket closes.
`Pulse status` is only ever written from a live read; a worker reporting
"resolved" changes *Next action*, never that column. `Done, To Notify Cust` is
not closed — it is the pending-validation queue.

**Never answer "how many are closed?" by adding up session reports.** The
director asked twice in one batch and got two wrong numbers, both assembled that
way: the first double-counted two tickets already in the list, and the second
quoted 18 from summaries when a live read showed 10. The failure is structural —
a released session's claim is unfalsifiable once its worktree is gone, and the
counts drift in the direction of looking productive.

Two traps when reading closures back:

- **The workspace's own "closed today" is not yours.** One count returned 199,
  of which almost all were support's bulk sweep — onboarding questions and
  migration timelines closed minutes apart. Filter to the ids you dispatched.
- **Say what you could not see.** A large listing may exceed the response limit
  and page out; state the coverage ("180 of 199 rows scanned") rather than
  reporting the visible subset as the whole.

## The three things every loop iteration reports

Gery, 2026-09-07, setting the loop definition: *"for each iteration pls report
1. status update for each codex subagent, check each codex subagent, ensure we
have at least 10 active codex subagent 2. how many ticket has been completed
3. for the blocker, why is it a blocker? why can't u solve it urself?"*

**1. Per-subagent status, and refill to 10 in the same pass.** One row each,
project name not session name, plus the one thing it is blocked on. Then confirm
the fleet is at ten *active*. Short means refill now and say what was dispatched
— not "under-filled" as a status.

Verify active from `codex-session.sh mine` showing `busy`. **A dispatch exiting 0
is not evidence a session is working.** Two sessions sat at an empty Codex prompt
with the brief never submitted while the command reported success; both were
found only because `mine` said IDLE minutes after dispatch. Re-dispatch and send
a trailing Enter when that happens.

**2. Tickets completed, reported from the local working document.**
`.artifacts/orchestration/pulse-ledger.md` **is** the source for this count.
*"for the pulse ticket, i want u to report based on ur local working document"*
— do not run live Pulse listing reads to produce it. Those listings are enormous,
get truncated into tool-result files, and burn a large amount of context to
recover a number the ledger already holds. One iteration spent four listing calls
and two failed SQL attempts before landing on a figure the ledger could have
given immediately.

What makes the ledger trustworthy is keeping it current **as each session closes
out** — update the row in the same pass you record the closeout, never in a
catch-up sweep later. Give the number with its denominator, and separate
genuinely closed from parked in `Done, To Notify Cust` awaiting validation; a
ticket in that queue is not closed. Never count by adding up subagent
self-reports — that produced two wrong counts before the ledger existed.

Live Pulse reads remain correct for *writing* a ticket and for reading one
specific ticket back after a write. It is the bulk listing for a count that is
banned.

**3. For every blocker, why is it a blocker and why can you not solve it.** This
is the question he actually wants answered, and it is a filter, not a format. If
the honest answer is that you can solve it, solve it instead of reporting it — a
constraint you invented is not a blocker (Rule 2), and reporting its consequence
charges him for a wall you built.

Genuinely his, and roughly the whole list: product direction and priority,
product semantics, commercial and pricing decisions, a live customer-visible
defect worth interrupting current work for, and anything the AI-behaviour hold
covers. Everything else is yours.

Each pass also sweeps open deliverables — merged-but-undeployed, the `to_notify`
queue, unapplied tenant configuration — and kills orphaned local E2E Docker
stacks left behind by finished sessions.

## Reporting format

Counts with denominators ("8/10", not "mostly"). Before/after as a table. Trace
and span ids, exact SQL, verbatim samples over paraphrase. Detail, not summary.
Every decision row **names the decision** — *"'your call' is now an
anti-pattern."* For client-facing items, recommend a resolution per item rather
than relaying the raw question. For Slack: explicit done-vs-pending structure,
never a raw dump.

### Status-table row rules

The shape is in `SKILL.md` § The status report. Per row:

- **Project name, not session name.** The director thinks in projects.
- **Status is a state plus its one blocking fact**: `Building — 9/15 done`,
  `Done — PR #14975, CI running`, `Investigating`. Not a sentence.
- **Bold every row whose next move is the director's**, and say what is needed —
  `**Not started — your call**`, `**Blocked — needs your yes on tiers**`. This is
  the one thing they cannot get from anywhere else.
- Include finished projects. "Done" is status.
- Include work nobody is doing. That row is the most likely to be forgotten, and
  usually theirs.

Explanation goes **after** the table, only for rows they will ask about, and only
a line or two. If a finding genuinely needs a paragraph, that is its own report
on its own turn.


## Closing a session's rows

**`closeout` records the session. It does not record the work.** The ledger is
the working document and the only thing that survives the worktree, so a row
that still reads `Todo` is untouched work as far as anyone can tell — including
you, next pass.

> Observed failure: eight tickets were shipped, applied, or explicitly decided —
> Papandayan implemented and on release, Tonata configured and verified,
> Orthopoint's deletes applied and read back, KLA and SinkGard both shipped —
> and every one of them still sat at `Todo`. A count of "50 Todo" was reported to
> the director as a throughput problem. It was a bookkeeping problem. The
> `Subagent` column was empty on all of them, so the manager could not even
> answer "is this in progress?" from the ledger and answered from memory,
> wrongly.

**Before you `stop` a session, its rows must be complete.** Every column, every
ticket that session touched:

| Column | What it must say |
|---|---|
| `Subagent` | The session slug. Empty means nobody can tell who touched it. |
| `Verdict` | What it is — the root cause, or why there is none. |
| `Pulse status` | The **real** state. If the fix shipped, it is not `Todo`. |
| `Next action` | The one thing that would advance it, and who owns it. |
| `Evidence` | Commit SHA plus a production observation **with a denominator**. |
| `Area` | Where it sits, from the fixed list. |
| `Root cause` | From the fixed vocabulary — this is what aggregates. |

`Root cause` and `Area` use **controlled vocabularies, never free text.** Free
text cannot be grouped, and the point of these columns is that the director can
pull the distribution and target a fix at the biggest bucket. A row tagged
`unrecorded` is honest; a row with an unaggregatable one-off phrase is not.

**The status must match reality, not effort.** Shipped and deployed goes to
`Done, To Notify Cust`. Decided-and-nothing-to-build gets the status that says
so. Blocked on the client is `Pending Customer Data`, not `Todo`. Reserve `Todo`
for work that genuinely has not started.

Do this in the same pass as the `closeout`, before `stop` removes the worktree.
A session whose rows are incomplete is not finished, however good its diff was.



## Voice

Short, lowercase, direct. "pls" not "please". Approval is one word. Correction is
blunt and immediately followed by the next instruction — never a lecture, never
an apology. Detail, not summary: *"give me the detail, I don't need the
summary."* Counts carry denominators.

Do not spend his attention on typos, formatting, doc polish, cosmetic leftovers,
demo shortcuts, low-priority items, or a self-corrected mistake.



## Pre-flight before reporting up

Run the pre-flight in [`pushback-rules.md`](./pushback-rules.md)
— 30 cause→effect triggers with the verbatim correction each earned. If your draft
trips one, fix it first. The most frequent is not technical: it is an unclear
answer. *"I don't understand ur explanation."*

His recurring workflows — AI-behaviour validation, ship/closeout, staged rollout,
backfill, incident, agent-spec migration — with their preconditions, tool routing
and reporting format are in
this file.

The one you will reach for most, beyond the Rule 1c closeout — **AI behaviour:**
export a real prod span → **baseline pass rate first** → modify the span directly
→ n=10, bar 10/10 → classify each failure as agent / fixture / judge / harness
error *before* touching a spec.

