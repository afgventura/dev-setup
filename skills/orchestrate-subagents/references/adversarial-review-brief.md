# Briefing the adversarial reviewer

The standard is defined in `/ai-behaviour-policy` → "End-to-End Adversarial
Review"; this page is how the manager applies it when a change touches the planner
high-caution area, the `send_messages` seam, the style/language stage or a
translator, a per-agent or per-tenant flag that changes what a customer receives,
or a shared default.

## Rules for the manager

- **A different session.** Not the implementer, not the planner of the change.
  Acquire a fresh `codex-wt-<slug>-review` session; it reads the change worktree
  read-only and edits nothing.
- **Brief the flow, not the diff.** Name every seam the reviewer must walk from
  inbound trigger to customer-visible delivery, every population it must prove
  untouched **with an artifact** (prompt bytes, model-call list, writes), and every
  default/fallback site it must answer. If you cannot name the seams, you do not
  understand the change well enough to ship it.
- **Verify the artifacts yourself** before relaying "no blockers" — a reviewer's
  sentence is a self-report too. Open the quoted prompt diff, count the calls,
  read the write list.
- **Findings go back to the implementer; the reviewer re-checks the delta;**
  finalize only on `CLEAR`. `/finalize-change` gate 3d records all of this.

Why: on 2026-09-15 a review scoped to "the detector and cache paths" cleared a
diff that pinned every tenant's styler to Banjarese for seven hours
(`32503d2c53`, hotfix `bca74e9058`). The seam that broke — `send_messages` →
style stage target language — was never in the reviewer's brief, and both the
manager and the reviewer accepted "empty array is byte-identical" without an
artifact.

## Brief skeleton

```
# Task: end-to-end adversarial review of <change> (read-only; no edits)

Review the UNCOMMITTED diff in <worktree> (`git -C <worktree> diff` + untracked
files: …). Do not edit; no model comparisons; no tsc/typecheck/e2e.

## What the change does (decided; do not re-open)
<3–6 bullets in the director's terms>

## Seams you must walk (all of them, in order)
inbound handler → planner context (<file>) → tool loop → send_messages
(<file:fn>) → style/language stage (<file>) → delivery → persistence: <tables,
cache keys, room metadata> → config surfaces: UI card, BFF route, MCP schema,
repository, PostgREST types, change-set diff.
For every value the diff introduces / renames / retypes / defaults, grep every
reader and read it.

## Populations you must prove untouched — with an artifact each
- <flag off / empty array agent>: quote the styler system prompt bytes and the
  model-call list for one representative turn before vs after (from the focused
  test or a replay), and the list of DB/metadata/cache writes.
- <other tenants / channels / languages / background mode>: same.
No artifact ⇒ BLOCKER.

## Defaults and fallbacks
List every `?? x`, default parameter, `|| fallback`, `[0]`, enum default and
empty-collection path in the diff; for each, say which population reaches it and
what they received before.

## Rollout
Migration order vs pods on the old image; backfills; cache keys other features
read; provider rate limits; retries/replays on the hot path.

## The smoke runs
The implementer's summary carries two `smoke-planner-reply.ts` outputs (an agent
without the feature, an agent with it). Read the styled replies yourself: the
language, the vocabulary, the tool sequence. If they are missing, that is a
BLOCKER before anything else.

## Output
Numbered BLOCKER / SHOULD FIX / NIT with file:line and a one-line failure
scenario. "No blockers" must list the seams checked and the artifacts produced.
After fixes you will be asked to re-check the delta: answer CLEAR or a new list.

## Other sessions are not yours
Never `tmux kill-session`, `kill` a codex process, or run
`codex-session.sh stop`/`stop-all`/`sweep`.
```
