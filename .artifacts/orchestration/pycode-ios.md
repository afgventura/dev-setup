# Orchestration Log — Pi iOS client

**Task:** Build a native Swift iOS app that brings Claude Code, Codex, and Pi coding agent/harness session UX to mobile through a WebSocket relay, showing current AI state and replies and supporting interactive questions.
**Opened:** 2026-09-16 13:12 WIB
**Directed by:** Gery | **Standing in as manager:** yes
**My `ORCHESTRATOR_ID`:** `pi-mobile-manager-20260310`

## 0. Gate

- [x] Scope classified: additive developer tool, platform-wide.
- [x] Configuration surface checked first: no existing mobile surface in this repository.
- [x] Already fixed: repository contains no iOS/relay implementation.
- [x] Someone already on it: no existing owned Codex sessions or attached worktrees.
- [x] Literal ask: native Swift mobile UI for Claude Code, Codex, and the Pi coding agent/harness via a WebSocket relay, focused on state, replies, and answering questions.
- [x] Product decisions extracted: native Swift; no React Native; relay is allowed; tool-call detail is not important; interactive questions must work.

## 1. Baseline

Not applicable: new additive project, no production behavior or model-call cost change.

## 2. Brief

Brief: `.artifacts/orchestration/pycode-ios/codex-brief-wt-pycode-ios.md`. Dispatch skipped the ticket Gate A because this is a new additive project, not a customer/Pulse ticket.

## 3. Workers

| Worker | Sheet | Worktree / branch | Acquired at | Task | State | Last check | Blocker | Owner |
|---|---|---|---|---|---|---|---|---|
| `wt-pycode-ios` | `pycode-ios/worker.md` | `/Users/gerywahyu/Workspace/haloai-wt/wt-pycode-ios` · `agent/pycode-ios` | 2026-09-16 13:12 WIB | Build app + relay | fixing review 2 | 13:46 WIB | reconnect/dedupe/question lifecycle gaps | Codex |

Doctor: 0 attached worktrees, 0 litter, 0 dirty worktrees, 0 unpushed worktrees, 0 shared stashes. Director checkout has one pre-existing untracked `.pi/` path; it will not be touched.

## 4. Verification

Plan approved at 13:19 WIB with correction: use documented Pi RPC (`pi --mode rpc`) and strict-LF JSONL; no PTY fallback; preserve Pi session persistence; implement honest provider adapters only.

Review 1 at 13:33 WIB: rejected initial diff. Blocking findings: no real iOS app target; broken initial auth/reconnect; invalid/racy manual WebSocket framing; cross-session command broadcast; snapshots/sequence ignored; streaming duplicates; raw/sensitive state persistence; prompt command persistence; questions never clear; failures hidden. Sent `.artifacts/orchestration/pycode-ios/review-1.md` for correction.

Review 2 at 13:46 WIB: simulator app target now builds and auth/routing structure improved. Still rejected: bridge never reconnects; Pi rehydrate uses random IDs and duplicates; deltas overwrite; `agent_end` mislabels idle; multi-select/prefill/no semantics incomplete; unauthorized loops; tests do not prove reconnect/dedupe/isolation; dead duplicate mapper; docs mismatch; relay frame robustness gaps. Sent `.artifacts/orchestration/pycode-ios/review-2.md`.

## 5. Pre-flight

Pending.

## 6. Closeout

Pending.

## 7. For him

| # | Item | Why it's his | My recommendation |
|---|---|---|---|
| 1 | Distribution and remote hosting | product/deployment direction after local MVP exists | Start local/self-hosted with pairing token, then choose hosted relay/TestFlight after validating UX. |
