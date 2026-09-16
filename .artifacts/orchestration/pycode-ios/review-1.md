# Review 1 — fix the Pi mobile MVP before finalization

Do not finalize yet. The build checks pass, but the current diff does not satisfy the primary flow. Fix these findings in the same task/worktree, then stop with a new diff and focused evidence.

## Blocking correctness findings

1. **This is not yet a runnable iOS app target.** `swift build --package-path ios` built the macOS executable. The Swift package scheme reports no supported iOS buildable destination when invoked with `xcodebuild`. Create a real native iOS application project/target (no React Native), with an app bundle that `xcodebuild` can compile for an installed iPhone simulator. Keep generated build output ignored. Verify with a focused `xcodebuild ... -destination 'platform=iOS Simulator,...' CODE_SIGNING_ALLOWED=NO build` command.

2. **Initial connection/pairing is broken.** The app connects at launch with an empty token. The relay upgrades unauthorized sockets and leaves them open; saving a token/URL never reconnects the model. Replace the misleading “Pair” claim with a simple honest connection setup unless you implement real one-time pairing. Saving credentials must disconnect/reconnect immediately and expose connection/auth errors in the UI. Invalid relay URLs must not crash (`URL(...)!` is prohibited). Unauthorized peers must receive a clear failure and close.

3. **The manual bridge WebSocket client is invalid and racy.** Its outbound frame declares a 4-byte mask but appends an 8-byte ASCII mask, corrupting frames. It sends subscribe/RPC rehydration after an arbitrary 30 ms instead of validating the HTTP 101 handshake, and contains dead `readFrames()` code referencing undefined `buffer`. Replace this with Node 24’s built-in standards-compliant `WebSocket`. Authenticate as the first WebSocket message (`{type:"authenticate", token, role}`) so both Node and URLSession clients share one explicit flow and secrets do not go in URLs. The relay must reject all non-auth messages before authentication.

4. **Commands are routed to every bridge.** Relay routing currently sends a prompt/answer for one session to all bridge peers. Track which authenticated bridge registered/subscribed each session and route only to that owning bridge. Reject commands for sessions without an online owner. Test two bridges/sessions to prove isolation.

5. **Snapshots/reconnect do not work.** The iOS client ignores `snapshot.events`, does not track sequence numbers, does not deduplicate, and sends no acknowledgements. Apply snapshot events in order, maintain a per-session last sequence cursor, ignore duplicate/older events, and send acknowledgements. Preserve cursor/state through app reconnect as appropriate, then reconcile with snapshots.

6. **Streaming duplicates and corrupts messages.** The bridge publishes text deltas and then publishes the full final `message_end` as another message. The app appends any new streaming delta to the previous assistant message, even if that previous message was already complete. Add stable normalized message IDs plus an explicit streaming/final lifecycle. Deltas update only their matching in-flight message; final replaces/finalizes it. Rehydrated Pi history must reconcile by stable identity rather than append duplicate relay history. Add tests covering two assistant messages, delta+final, relay restart, and bridge rehydrate.

7. **AI state is not normalized.** The UI ends up showing raw values such as `message_end` or `tool_execution_end`, and `agent_settled` is not handled. Publish small useful states such as connecting/idle/running/waitingForInput/retrying/compacting/error/disconnected. Do not persist tool arguments/results or entire Pi events in `state.detail`; the director explicitly does not care about tool-call detail, and this can persist sensitive output.

8. **The relay persists prompt contents despite documentation implying otherwise.** `publish(... {type:"command", payload:msg})` stores prompts and answers in `.remote-agent-state.json`. Do not persist command payloads. Echo a normalized user message with a stable ID if the chat should show sent prompts, but keep command transport and persisted history privacy explicit and accurate. Do not claim prompt contents are not stored if chat history intentionally stores them.

9. **Question lifecycle is incomplete.** After an answer/cancel, the active question stays visible and can be submitted repeatedly. Publish/handle question resolution and clear it. Preserve `editor` prefill. Implement the provider-neutral `multi_select` UI already claimed by the protocol, even though standard Pi RPC only emits select/confirm/input/editor. Ensure confirmation supports explicit yes/no/cancel semantics rather than only confirm/cancel if the provider supplies them.

10. **The app hides failures.** Surface disconnected/reconnecting/unauthorized/invalid URL/session unavailable states. Do not recursively call `receive()` forever; use a cancellable receive loop with one reconnect task and bounded backoff. Avoid duplicate concurrent connects.

## Quality and evidence

- Reformat the dense one-line Swift/Node code into maintainable code before returning it. The current format makes protocol/security review unnecessarily risky.
- Add focused relay tests for authentication, unauthorized close, snapshot replay, sequence monotonicity/deduplication, and two-session bridge routing. Add bridge tests for strict LF parsing and normalized Pi event mapping without invoking a model.
- Verify the actual iOS simulator target builds, not only macOS SwiftPM.
- Keep Claude Code/Codex support honestly adapter-ready unless a real protocol is implemented.
- Do not run full E2E suites or leave a server/simulator process running.
- Return the complete diff and exact test/build commands. Do not run `/finalize-change` until I approve this revision.
