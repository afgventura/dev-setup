# Subagent Session — <slug>

Copy to `.artifacts/orchestration/<task-slug>/<slug>.md`. **One sheet per
subagent.** Duplicate it per worker and fill it top to bottom as the session
runs; do not hold any of this in your head.

The multi-worker rollup lives in `orchestration-log.md`. This sheet is the
procedure for *one* worker: worktree in, worktree out.

**Worker slug:** `<slug>` · **Session:** `codex-wt-<slug>` · **Worktree:**
`<workspace>/haloai-wt/wt-<slug>` · **Branch:** `agent/<slug>`
**Task:** <one line> · **Opened:** <YYYY-MM-DD HH:MM WIB>

---

## 1. Scope — before the worktree exists

- [ ] Scope classified: one business / a cohort / new-tenant defaults / platform-wide → `<answer>`
- [ ] Configuration surface checked before code — is there a supported config/MCP operation?
- [ ] Already fixed on `origin/main`, or already owned by someone else? Checked.
- [ ] Literal ask restated in one line, neither broadened nor narrowed: `<line>`
- [ ] Product decisions extracted (his): `<list, or "none">`

Ambiguity that changes the storage surface or blast radius goes to the director
**now**. Everything else is yours.

## 2. Create the worktree

Default runtime is a git worktree, one per subagent — **not** a sibling clone,
and **not** a session that already finished another task. This sheet covers one
task; a new task starts at §2 with a new `acquire`, never by reusing a live
session whose worktree is still on the previous task's branch and base.

```bash
S=.agents/skills/orchestrate-subagents/scripts/codex-session.sh
$S list                                   # always look first
$S acquire <slug>                         # worktree + branch + codex session
```

`acquire` fetches `origin/main`, creates `haloai-wt/wt-<slug>` on `agent/<slug>`,
runs `pnpm install`, and starts Codex there. It records the worktree as **owned**,
which is what makes teardown in §8 remove it.

- [ ] `session=` `<…>` · `repo=` `<…>` · `branch=` `<…>` recorded above
- [ ] `owned_worktree=yes` in the acquire output — if it says `no`, teardown will
      not clean up and §8 becomes manual
- [ ] Dependencies installed (or `--no-install` was deliberate and the session was
      told it cannot run tests or `/finalize-change` until they are)
- [ ] Baseline captured: `git -C <repo> status --porcelain` empty,
      `git -C <repo> log --oneline -1` = `<sha>`
- [ ] Sandbox policy checked: `grep -E "sandbox_mode|approval_policy" ~/.codex/config.toml`
      → `<value>`. Under `workspace-write` its `.git` is read-only and it
      **cannot commit or push**, so it cannot run `/finalize-change` — fix the
      policy or do not brief that requirement.
- [ ] Director told which worktree this is, and `tmux attach -t codex-wt-<slug>`

Never split one coherent change across two worktrees; each produces its own diff
and nothing reconciles them.

## 3. Brief

Follow [`../references/brief-template.md`](../references/brief-template.md).
One file per task, in the session scratchpad, named for the worker.

- [ ] Director's words quoted verbatim, not paraphrased
- [ ] `Out of scope` list written — the single most effective line in the brief
- [ ] Repository skills named (`/backend`, `/frontend`, `/erp`, …)
- [ ] Repository rules quoted with their exceptions intact, never compressed
- [ ] **`/finalize-change` requirement stated** — see §5; it is not optional
- [ ] No design pre-solved by me; the agent still has something to ask
- [ ] Brief file: `<path>`

## 4. Dispatch and plan check

```bash
$S dispatch <session> <brief-file>   # returns immediately
$S status <session>                  # busy | idle
$S wait <session>                    # block until the turn ends
```

The brief makes the first reply a **plan, not a diff**. This is the cheapest
correction point in the loop; everything after it costs a rebuild.

- [ ] Plan read against the director's quoted words
- [ ] Its ambiguities answered by me from context — only genuine product
      decisions went to the director
- [ ] Where the result is computed, where it is stored, and what happens on the
      second read / after a deploy / on another pod — all answered
- [ ] Plan approved, or sent back. Rounds: `<n>`

Do not babysit the session and do not narrate its intermediate steps. It also
goes idle when it stops to *ask* something, not only when it finishes.

- [ ] **Monitoring loop running.** `/loop` with no interval, started at the first
      dispatch, self-paced: 60–120s while a plan or short turn is expected,
      300–600s mid-implementation, 1200–1800s when everything sits with the
      director. Nothing else wakes you when a tmux Codex session goes idle.
- [ ] Loop stopped once this worker is torn down and no other worker is live.

## 5. `/finalize-change` — after every code change

**Every code change this session makes ends with `/finalize-change`.** Not the
last one; every one. It owns simplification, focused tests, the commit, and the
push, and it keeps its own log at `.artifacts/finalization/<slug>.md`.

Order, so review still gates the work:

1. Agent implements and stops with a diff.
2. I verify the diff (§6).
3. Agent runs `/finalize-change` in its own worktree.
4. Any follow-up fix repeats 1–3. A review fix is a code change; it gets its own
   `/finalize-change`.

- [ ] Brief stated it (§3), in these terms: *after every code change, run
      `/finalize-change` in this worktree; a change is not done until it reports
      finalized*
- [ ] `/finalize-change` actually ran — log exists, every applicable box ticked
- [ ] Commit `<sha>` verified on `origin/main` (`git -C <repo> log origin/main --oneline | grep <sha>`)
- [ ] If it reported **not finalized**, the named blocker is written here:
      `<blocker>` — this section is not done until it clears

| Change | Diff reviewed | `/finalize-change` | Commit on origin/main |
|---|---|---|---|
| | | | |

## 6. Verify — its summary is a claim, not evidence

```bash
git -C <repo> status --porcelain    # against the §2 baseline
git -C <repo> diff
```

Always pass `-C <repo>`. A bare `git diff` inspects your own checkout and shows a
clean tree while the real changes sit in the worktree.

Read every hunk for:

- [ ] **Scope** — unrequested refactors, drive-by renames, reformatting are findings
- [ ] **Baseline** — nothing touched that was already dirty
- [ ] **Repository invariants** — no new PostgREST app-data calls, no `!`
      non-null assertions, no barrel files, no tenant names/IDs in shared
      components, no new fatal validation on a reliability path, no Trigger.dev
      tasks, no `business_config_public` references
- [ ] **Correctness** — it does what was asked, not something adjacent that
      passes the tests
- [ ] **Tests prove the failure is prevented**, not that a mechanism was
      configured. This is usually the highest-value finding.
- [ ] Verified against primary data (ledger / DB / span / running system), not the
      pane text
- [ ] A **fresh** session graded it where the change is large — the implementer
      never grades its own work

Do not run `tsc` or `pnpm typecheck`; `tsgo` gets OOM-killed (exit 137) here and
that is not a pass. Do not wait on CI: a PR runs no tests in this repository, so
this review is the gate.

Send failures back with the **exact** error text:

```bash
$S ask <session> "<exact failure>. Fix it."
```

| Claim | Evidence | Verdict |
|---|---|---|
| | | confirmed / refuted / unproven |

## 7. Report up — in the same turn the session goes idle

Two to five lines, in the director's terms. Name the worker.

- [ ] What changed
- [ ] What I verified and the result
- [ ] Anything unverified, or an assumption the agent made
- [ ] What I want from him next, if anything

Not batched into a later recap — his feedback is the input to the next brief, and
delaying it stalls the worker.

## 8. Teardown — the worktree dies with the session

A worktree created for a subagent is removed when that subagent is killed. An
abandoned worktree is invisible state: it pins a branch, a full `node_modules`,
and an unreviewed diff that no session sweep will ever surface.

### Ship gate — all three before anything below

A session is done when the change runs in production and something other than
your own reasoning says it works. Not when the diff is good.

Record the gate with the session tool before running `$S stop`:

```bash
$S closeout codex-wt-<slug> \
  --finalize-sha <commit-on-origin-main> \
  --deployed "<deployment mechanism>" \
  --validated "<live validation evidence>"
```

- [ ] **1. `/finalize-change`** reported finalized, commit on `origin/main`.
      sha: `<…>`
- [ ] **2. Deployed.** Merging is not shipping. Name the mechanism that carried
      it: `<push to release / apps/walex deploy / …>`. A separately deployed
      service needs its own deploy on top of the web promotion. Batching several
      changes into one promotion is fine; skipping is not.
      deployed at: `<…>`
- [ ] **3. `/validate-production-change`** run against the live system, and it
      confirmed the fixed behaviour. evidence: `<…>`
- [ ] Issue closed and the reporter told, **after** step 3 — not before.

For an investigation, rejected plan, or other session with no change to ship,
record the explicit exception instead:

```bash
$S closeout codex-wt-<slug> --no-ship "<why there is no change to deploy>"
```

Blank values and placeholders such as `n/a`, `todo`, `-`, and `pending` are
rejected. `--force` is an intentional bypass, prints the missing steps loudly,
and is not a substitute for doing them.

Do not tick 3 from a passing test suite. A test proves the code does what its
author thought; only step 3 can tell you the change does not work. That is why it
is the step that gets skipped, and the only one that would have caught an
ad-attribution filter that was approved on a code read, marked shipped, and found
broken in production by its reporter.

If a step genuinely cannot run, write the blocker here rather than leaving the
box unticked and moving on: `<…>`

```bash
$S stop codex-wt-<slug>                    # release session + remove worktree
$S stop codex-wt-<slug> --delete-branch     # also drop the branch
$S stop codex-wt-<slug> --keep-worktree     # deliberately keep it — say why below
```

`stop` first requires the recorded closeout above, then refuses to remove a
worktree with uncommitted work or with commits that are not on `origin/main`,
and tells you which. Those refusals are signals to do the missing work — clear
the closeout with the real step, not with `--force`. `--force` discards the work
and loudly records the closeout bypass in its output.

- [ ] Work is on `origin/main` (§5), or deliberately kept — reason: `<…>`
- [ ] `$S stop codex-wt-<slug>` run, and it reported `removed worktree …`
- [ ] `git -C <main-repo> worktree list` no longer lists `wt-<slug>`
- [ ] `<workspace>/haloai-wt/wt-<slug>` gone from disk
- [ ] Branch `agent/<slug>` deleted, or kept for a stated reason: `<…>`
- [ ] Nothing left running: no dev server, watcher, port-forward, or browser
      automation started for this worker

If the director changes direction mid-flight, teardown still runs. An
interruption is not an exemption.
