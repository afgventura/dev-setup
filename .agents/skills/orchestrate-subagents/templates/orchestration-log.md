# Orchestration Log — <task name>

Copy to `.artifacts/orchestration/<task-slug>.md`. Keep it current as you work;
this is the state, not your context window. Never delete a row — strike it and
note why.

This is the **rollup across workers**. The step-by-step for one worker —
worktree, brief, plan check, verify, `/finalize-change`, teardown — is
[`subagent-session.md`](subagent-session.md); copy that sheet once per subagent
into `.artifacts/orchestration/<task-slug>/<slug>.md` and link it from §3 below.

**Task:** <one line, the literal ask>
**Opened:** <YYYY-MM-DD HH:MM WIB>
**Directed by:** Gery | **Standing in as manager:** yes
**My `ORCHESTRATOR_ID`:** `<set this before the first acquire>`

---

## 0. Gate — before any worker is briefed

- [ ] **Scope classified**: one business / a cohort / new-tenant defaults / platform-wide.
      → `<answer>`. If unclear and it changes the storage surface or blast radius, **ask him now**; do not guess.
- [ ] **Configuration surface checked first** — is there a supported config/MCP operation before any code?
- [ ] **Already fixed?** Checked remote `main` and open PRs. He does not want re-raised, already-fixed items.
- [ ] **Someone already on it?** Checked Slack / pod channel / ledger to avoid duplicate work.
- [ ] **Literal ask restated in one line** — neither broadened nor narrowed.
- [ ] **Product decisions extracted**: `<list, or "none">` → these are his; everything else is mine.

## 1. Baseline — captured before anything changes

Required for any AI-behaviour, performance, or cost change. No baseline, no claim.

| What | Source (span/trace/query) | Value | n |
|---|---|---|---|
| | | | |

- [ ] Baseline is from **real production data**, not a mock or synthetic case.
- [ ] **Harness validated** — measurement instrument ruled out as the bug before trusting any number.

## 2. Brief — what I actually sent the worker

Not a copy-paste of his message. A better prompt than the one I received.

```
<the brief as sent>
```

- [ ] States the objective and the invariant, not a rule list.
- [ ] Names the correct tool/skill for the scale (local vs Cloud Run; cloud-sql-mcp vs chrome-mcp; `gh` over browser).
- [ ] States what is explicitly **out** of scope.
- [ ] Says what evidence the worker must return.

## 3. Workers — live status

One row per subagent **I acquired**. Each has its own worktree and its own sheet.
A session I did not acquire does not get a row here — it is not mine to drive.

| Worker | Sheet | Worktree / branch | Acquired at | Task | State | Last check | Blocker | Owner of blocker |
|---|---|---|---|---|---|---|---|---|
| `wt-<slug>` | `<slug>.md` | `haloai-wt/wt-<slug>` · `agent/<slug>` | `<UTC>` | | running / done / blocked / idle | | | me / him / client |

- [ ] **Every row here came from my own `acquire`.** Verified with
      `codex-session.sh mine`, not from memory. Before dispatching to, merging
      from, or stopping any session, it appears in this table.
- [ ] Sessions running on this machine that are **not** mine are listed below with
      no action taken — read-only. Report them; do not drive them.
- [ ] **No worker is idle.** An idle worker is a failure of my job, not theirs.
- [ ] **`codex-session.sh doctor` run at the top of this wave**, and its warnings
      acted on: director repo synced and clean, no new stash entries, and every
      worktree it lists as holding unpushed commits is a session I am tracking.
      `<paste the counts>`
- [ ] Every worker has its own worktree — no two sessions in one checkout, and no
      coherent change split across two worktrees.
- [ ] **No row covers two tasks.** One session, one worktree, one task. A session
      whose task is done was `stop`ped; the next task got its own `acquire` and
      its own row, never a second brief into the free session.
- [ ] Not waiting on CI or a deploy — pushed and moved to the next task.
- [ ] A blocked worker has an attempted second route before it is called blocked.
- [ ] Every worker's code change ended in `/finalize-change`; the sheet records
      the commit on `origin/main`.

## 4. Verification — independent of the worker's word

- [ ] Verified against **primary data** (ledger / DB / span / running image), not the worker's self-report or its pane text.
- [ ] A fresh session ran the check — the implementer did not grade its own work.
- [ ] Every claimed number cross-checked against a second source where one exists.
- [ ] Bug claims carry a trace/span id. Without one the claim does not count.
- [ ] Multi-site change: **each changed path** regression-checked, not an aggregate pass.

| Claim | Evidence | Verdict |
|---|---|---|
| | | confirmed / refuted / unproven |

## 5. Pre-flight — run before reporting up

Reject my own draft if any of these trip. Full list in `../references/pushback-rules.md`.

- [ ] Answers the **literal** question asked, at the exact metric and cohort.
- [ ] Plain terms; every term defined inline; no ungrounded jargon.
- [ ] Detail, not summary. Counts have denominators. Before/after is a table.
- [ ] No claim about system state derived from repo grep alone.
- [ ] Any default I surface comes with **why** it exists (commit/PR).
- [ ] Nothing built that already exists; no new wrapper, wire format, or fallback invented.
- [ ] No hardcoded tenant id, business name, or one-off value in shared code.
- [ ] No fatal validation added where degrade-and-log preserves a working path.
- [ ] Not blaming the model before proving the harness exposed the tool/context.
- [ ] Scope is exactly the ask.
- [ ] Every decision row **names the decision**; no "your call".

## 6. Closeout

**Handoff.** `/finalize-change` owns the commit-to-push pipeline and keeps its own
log, and the **subagent** runs it in its own worktree after every code change. Do
not restate its checks here — verify it ran and completed, then do only what it
does not cover.

- [ ] `/finalize-change` completed for **every** code change, by the worker that
      made it. Log: `.artifacts/finalization/<slug>.md` — every applicable box
      ticked. Commit `<sha>` verified on `origin/main`.

That handoff covers clean tree and staged files, issue linked and closed,
Terraform apply and zero-drift plan, and agent-started processes stopped. If it
reported **not finalized**, the named blocker is the deliverable here — this
section is not done.

**What `/finalize-change` does not do.** It explicitly does not deploy
application services, so everything past the push is the manager's:

- [ ] Deployed, then `/validate-production-change` with evidence — not elapsed time.
- [ ] Staged rollout respected where risky: 1% → monitor → 10% → wider.
- [ ] Screenshot attached for any user-visible change.
- [ ] Post-deploy production re-sampled and compared to §1 baseline.
- [ ] Lesson worth keeping → codified into a skill/doc, not left as a one-off correction.

**Teardown.** Every worker killed, every worktree it owned removed.

- [ ] Each worker's §8 teardown done: `stop codex-wt-<slug>` reported
      `removed worktree …`.
- [ ] `git -C <main-repo> worktree list` shows no `wt-<slug>` from this task.
- [ ] Any worktree deliberately kept is listed here with its reason: `<…>`
- [ ] No dev server, watcher, port-forward, or browser automation left running.

## 7. For him — the only things that need his attention

Keep this short. Product direction, genuine external blockers, and finished work
awaiting feedback. Nothing procedural.

| # | Item | Why it's his | My recommendation |
|---|---|---|---|
| 1 | | product direction / client blocker / needs feedback | |

**Report line** (paste-ready, his register — what moved, not what was inspected):

```
<n> done, <n> running, <n> blocked.
Moved: <…>
Yours: <…>
```
