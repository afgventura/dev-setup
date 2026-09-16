# Standing fences

**Scope.** Workspace `019951bc-7de0-75df-a3bc-c915e5837fe3`, division
`Tribe Support` ONLY. Pass the division filter on EVERY `pulse_list_tickets`
call. A ticket outside Tribe Support is not ours.

**PLATFORM ONLY.** Triage everything, but the moment a ticket resolves to tenant
scope, write `scope`/`root_cause`/`evidence`/`worked_by` onto the ticket and
STOP. Do not fix it. Do not write tenant config. Fix only what a fleet
denominator proves is shared. One client noticing a shared defect is still
platform — the client's name never settles it, a denominator does.

**TRIAGE IS A COUNTING QUESTION, NOT A TRACE HUNT.** If your next step is "get
the affected trace", closure work has started and it has gone wrong. Ask
instead: (a) does the code path branch on business at all — a shared path with
no per-business predicate is platform by construction, answerable from code with
no production access; (b) how many businesses show the condition — one business
is tenant, multiple businesses are platform. Report your DETERMINATION RATE.
Counting the affected businesses is the deciding evidence; trace hunting is not.

**AI BEHAVIOUR IS ON HOLD — the whole surface.** Do not change the agent spec or
its publication, agent configuration, prompts, guardrails, the planner, the
tool loop, or any model-visible tool contract (a tool's schema, its field names,
or whether a tool is offered to the model at all). Deterministic-and-real is NOT
an exemption — `one_shot` tool withdrawal was deterministic, correct, and still
had to be reverted. Before you touch anything ask "does this change what the
agent sees or does?" — if yes, record the finding and stop. Paths to check before
any commit: `models/bespoke-agent/**`, `planner/**`, anything touching a tool
schema. STILL IN SCOPE: tenant configuration that is not agent config,
backend/data/query defects, frontend and i18n, infrastructure, CI, ticket state.
CARVE-OUT: a deterministic cause sitting under an ai-behaviour label — bounds,
timeouts, idempotency, authorization, ordering, telemetry classification, data
loss, config plumbing, performance — is ordinary engineering and is in scope.

**NEVER send a client message.** `Done, To Notify Cust` is the name of a status,
not authority to contact anyone. Asks are DRAFTED for a human to send verbatim.

**Never close a ticket whose work is not done.** The single failure mode was *a
plausible commit attached to a ticket it does not resolve*. Before you attach a
sha, prove the diff touches the code path the ticket describes.

**DO NOT PICK UP A `Done, To Notify Cust` TICKET AND WORK IT AGAIN.** Its
engineering is finished. Only an explicitly briefed post-deploy validation pass
moves one — and this brief is not that unless it says so.

**Git.** Work only in your own worktree. NEVER `git stash` — the stash stack is
machine-wide across every worktree on this box. `git add` explicit paths only,
never `-A`, never `.`, never `-u`. Never `--no-verify` — if a hook stalls,
report the exact stall signature as an honest blocker.

**Tests.** SKIP E2E ENTIRELY. Unit/integration plus a revert-red proof is the
bar.

**NEVER RUN A TYPECHECK. DIRECTOR'S ORDER, 2026-09-09: "pls don't use typcheck
ya, it will kill my laptop."** No `tsc`, no `pnpm typecheck`, no `tsgo`, no
scoped config, no single-file check, no wrapper, no exceptions. CI is the only
typecheck authority, and "tests green" is NOT evidence the commit compiles.

**Finish.** End every code change with `/finalize-change`. Never remove your own
worktree — teardown is the orchestrator's.

**Ledger.** Write findings in incrementally, not at the end, by ABSOLUTE path:
`/Users/gerywahyu/Workspace/haloai-1/.artifacts/orchestration/pulse-ledger.md`
A relative path builds a parallel ledger that dies with the worktree.

**DO NOT RUN A FULL QUEUE CENSUS.** Pull ONLY the specific tickets you are
working, by id or by the narrow filter this brief gives you. A closing readback
is one ticket, not the queue.

**PULSE IS THE DURABLE RECORD, the ledger is a working view.** On EVERY ticket
you touch, write via `pulse_update_ticket` `custom_fields`: `scope`,
`root_cause`, `evidence`, `worked_by`. `validation_path` and `client_ask` are
NOT provisioned on the native entity and will be rejected — carry them inside
`evidence` as `VALIDATION_PATH:` and `CLIENT_ASK:` prefixed lines. `evidence`
carries the query you ran, the success denominator it returned, the recurrence
count, and the window bounds. A verdict word is not a record. Read it back.

**Telemetry field gotchas.** Axiom `status.code` is uppercase `ERROR` —
`== 'error'` returns a false zero. Cloud Logging's pino field is
`jsonPayload.msg`. A wrong field returns a clean 0 that reads as success.

**ACCEPTANCE RULE (the director's, and it replaced the old one).** A ticket may
close when all three hold: (1) monitoring says the shared path is OK, with a
REAL SUCCESS DENOMINATOR — an actual count of businesses or requests that
traversed it successfully, not "no errors found"; (2) the defect signature has
not recurred in that window for ANY business — the reporter's own case is NOT
required; (3) the window is long enough that the path was actually exercised —
0/0 is not a pass, zero traffic is not zero errors. Tickets failing only (3) are
`awaiting-exposure`, not failed.

**Claim discipline.** `worked_by` is the claim field, not the assignee — every
ticket is already assigned, and multiple orchestrators share this queue. Set
`worked_by` to your session name when you start, clear it if you hand the ticket
back untouched.
