# Task: Build a native iOS client and relay for Claude Code, Codex, and the Pi coding agent/harness

## What the director said

> Please create cloud code or codex in mobile app for iOS. Use native Swift, don't use React Native. Use codex subagent to work on this. The cloud code or codex app should work with PyCode so that I can use PyCode from my mobile app.
>
> You can create a relay server that use WebSockets to relay the packets in between, and the mobile app should be very simple. I really don't care about all the tool calls that the AI made. I just want to show what's the AI state right now and also what's the reply from them.
>
> Also implement all interfaces like questions and stuff so that I can also answer the question from my mobile app. Basically, we need a parity of with cloud code and also codex and also PyCode. Yeah, basically, we move the cloud code and codex UI and UX into this mobile app that we create for PyCode.

## Context

This is the `dev-setup` repository. It currently contains setup/configuration for Pi, Claude, Codex, tmux, and a small native Swift notifier, but no iOS app or relay server. The director clarified explicitly: the target is **Pi code — the Pi coding agent/harness, not “PyCode.”** “cloud code” in the original request means Claude Code.

The first release should be a useful, additive MVP rather than an exhaustive rendering of every provider event. Preserve a provider-neutral core so Claude Code, Codex, and Pi/PyCode can map into the same session/state/message/question model. The user explicitly does not care about verbose tool call streams. Prioritize session visibility, current state, assistant replies, sending prompts, interactive questions/choices, reconnect behavior, and basic secure pairing/authentication.

This task has no existing production deployment. Build a locally runnable/self-hosted baseline and document how a Mac-side agent process connects to the relay and how the iOS app connects. Avoid recurring hosted-service cost in this first implementation.

## Your worktree

You are working in `/Users/gerywahyu/Workspace/haloai-wt/wt-pycode-ios`, a git worktree of the repository, on branch `agent/pycode-ios` branched from `origin/main` at `ae5318b`. Treat the checkout as given: do not reset, and do not switch to a branch that is not yours. You MAY fetch `origin/main` and rebase or merge your own branch onto it when finalizing. Stay inside this directory; other worktrees belong to other agents.

## Scope

- In scope: a native Swift/SwiftUI iOS app; a WebSocket relay; a small Mac/CLI bridge or adapter layer needed to connect the Pi coding agent/harness and make Claude Code/Codex adapters possible; provider-neutral event contracts; session list/detail; visible run state; streaming/final replies; sending user prompts; every user-input surface needed for questions (single choice, multi-choice where supported, free text, confirmation/cancel); reconnect and duplicate-event handling; secure-by-default pairing/token handling; focused tests; setup and architecture documentation.
- In scope: choose a repository layout and build tooling that can be opened/built by another developer without committing user-specific secrets or generated junk.
- Out of scope: React Native; rich rendering of every tool call; a paid/hosted relay deployment; App Store/TestFlight release; voice, attachments, push notifications, background execution guarantees, multi-tenant admin, billing, or production analytics; changes to external Claude Code/Codex/Pi upstream projects.
- Out of scope: pretending unsupported provider internals are implemented. Use explicit adapter boundaries and document actual integration status.

## Other sessions are not yours

You are one of several Codex sessions on this machine, each in its own tmux session. Their lifecycle is owned by the manager. Never run `tmux kill-session`, `tmux kill-server`, kill a `codex` process, or run `codex-session.sh stop`/`stop-all`/`sweep`.

## Do not run end-to-end tests

Do not run full-corpus or resource-heavy end-to-end suites. Focused unit tests and iOS build/test commands are welcome. Do not leave servers, simulators, watchers, or background processes running after a turn.

## Finalize every code change

After every code change, stop with the diff for manager review before finalizing. Once approved, run `/finalize-change`. It owns simplification, focused tests, commit, and push; a change is not done until it reports finalized and the commit is on `origin/main`. If it reports not finalized, report the blocker. Never use `git stash`; commit work-in-progress on your own branch if needed.

## Repository rules

- Read and follow the repository root `AGENTS.md`.
- Use native Swift/SwiftUI only for the mobile app; no React Native or web-wrapper UI.
- Keep credentials out of source control and Keychain-backed on iOS.
- Favor simple, inspectable protocols and focused tests over framework-heavy abstractions.
- Do not modify the pre-existing untracked `.pi/` content in the director checkout; it is outside this worktree anyway.

## Investigation

You own the investigation. Inspect existing Pi/Claude/Codex configuration and scripts to understand realistic integration seams. Check locally available Pi documentation only if needed. Do not ask me to look up implementation details.

## Answer this before you build anything

Reply with only:

1. What you understand the director to be asking for.
2. Your proposed MVP architecture and repository layout, in a few lines.
3. Exactly how the Pi coding agent/harness works end-to-end in this first version, and what Claude Code/Codex support is real versus adapter-ready.
4. Where session/event state is computed and stored; reconnect behavior; duplicate ordering behavior; what happens after relay restart and app restart.
5. Security/pairing approach for the first version.
6. Any genuine product ambiguity, plus the least-cost assumption you recommend.

Do not write code yet. Stop and wait for approval.

## Definition of done

- A native SwiftUI iOS project builds with a documented command or Xcode workflow and contains a simple session list/detail/chat interface.
- The app shows normalized AI state and assistant replies without exposing noisy tool-call details by default.
- The app can send prompts and answer normalized interactive questions (choice, multi-choice where available, confirmation/cancel, and free text).
- A locally runnable WebSocket relay and Mac-side/provider bridge demonstrate the Pi coding agent/harness end-to-end; Claude Code and Codex have honest, documented adapters or integration seams with tests/fixtures.
- Connection auth/pairing, reconnect, sequencing/deduplication, and failure states are handled and tested at focused scope.
- README/setup docs explain architecture, security limits, run steps, and current provider support.
- No secrets or generated build output are committed.
- You stop with the complete diff and focused test/build evidence for manager review before running `/finalize-change`.
- After approval, `/finalize-change` reports finalized; provide the SHA and finalization log path.

## Report back

End the implementation reply with `## SUMMARY` containing files changed, verification evidence, unsupported items, and assumptions.
