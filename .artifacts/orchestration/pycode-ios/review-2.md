# Review 2 — remaining blocking defects

The revision is materially better and the simulator target builds, but it is not ready to finalize. Fix these remaining issues, add tests that prove them, then stop again for review.

1. **Bridge reconnect is missing.** `new WebSocket(relayURL)` is created once. Relay restart/network loss leaves the Pi process alive but the bridge never reconnects, re-authenticates, re-registers the session, or rehydrates. Implement one bounded-backoff reconnect loop around the WebSocket while keeping the same Pi RPC child alive. On reconnect: authenticate, subscribe/register only this session, then query Pi state and stable history. Handle Pi child exit by closing the bridge cleanly and making the relay owner go offline.

2. **Use stable Pi entry IDs for rehydration.** The current `get_messages` path assigns `randomUUID()` when messages have no ID, so every bridge reconnect republishes old history as new duplicates. Pi RPC provides `get_entries` with stable entry IDs/cursors. Rehydrate assistant and user messages from current-branch entries using their durable entry IDs (or another demonstrably stable identity), reconcile them without duplicates, and test reconnect/rehydrate twice.

3. **Streaming currently overwrites each delta.** The bridge publishes delta chunks, but `AgentModel.applyEvent` replaces existing message text with the newest chunk. Define explicit delta/final semantics: append deltas only to their matching in-flight message, then replace/finalize with authoritative full text at `message_end`. Test two consecutive assistant turns and multiple deltas.

4. **Do not mark `agent_end` idle.** Pi docs say `agent_end` is a low-level run and may be followed by retry, compaction, or queued continuation. Only `agent_settled` is authoritative idle. Normalize retry completion/error states accurately.

5. **Question controls still do not meet the review.** `multi_select` immediately submits a one-item array instead of allowing multiple selections and an explicit Submit. `editor` prefill is used as placeholder text rather than initial editable content. Confirmation still lacks an explicit No (`confirmed:false`) separate from Cancel where the protocol supports both. Implement all three correctly, and clear/disable the question immediately after local submission to prevent double taps while the relay resolution returns.

6. **Unauthorized state loops forever.** The app sets `connectionState = unauthorized`, then socket close enters the generic reconnect path, overwrites it with `reconnecting`, and retries bad credentials indefinitely. Treat auth failure/invalid configuration as terminal until the user saves new settings. Make reconnect ownership generation-safe so cancelling an old socket cannot nil out or restart a newly configured socket.

7. **Protocol tests do not prove key claims.** Add focused tests for bridge reconnect + double rehydrate dedupe, delta accumulation + final replacement across two turns, and actual cross-session non-delivery. The current routing test only checks that the second bridge remains open; it never asserts it did not receive the prompt. Avoid fixed test ports where practical.

8. **The Pi mapper test does not cover the code used by `pi-bridge.mjs`.** `normalize.mjs` duplicates part of the bridge logic, but the bridge never imports it. Consolidate normalization into testable production code or delete the dead mapper. Tests must exercise the exact mapper/state machine the bridge uses.

9. **Fix documentation mismatches.** This is an authenticate-with-shared-token connection, not pairing: change the remaining `Pair` UI/README wording. The token is in Keychain, not app preferences. The WebSocket protocol uses one JSON object per message; strict-LF JSONL applies only to Pi RPC stdin/stdout, so correct `protocol/README.md`. Document the real Xcode project/simulator build command, not only `swift build`/`open Package.swift`.

10. **WebSocket relay robustness.** Support or explicitly reject 64-bit inbound lengths with a bounded maximum rather than returning forever with the frame buffered. Reject unmasked client data frames, handle ping/close control frames correctly, and make state-file write failures observable without unhandled promise rejections. Keep this focused; do not introduce a third-party framework if unnecessary.

Re-run Node focused tests, syntax checks, `git diff --check`, and the actual iOS simulator `xcodebuild`. Do not run `/finalize-change` yet.
