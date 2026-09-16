# Remote Agent MVP

This is a self-hosted, local-network baseline: a Mac runs the relay and one
bridge, while the native SwiftUI app connects over WebSocket. There is no
hosted service, account system, push notification, or PTY integration.

## Run Pi

```sh
export RELAY_TOKEN="$(openssl rand -hex 32)"
node relay/server.mjs
RELAY_TOKEN="$RELAY_TOKEN" RELAY_URL=ws://MAC-LAN-IP:8765 \
  PI_SESSION_ID=my-project node bridge/pi-bridge.mjs
```

The bridge launches `pi --mode rpc` and preserves Pi's normal session storage.
Set `PI_SESSION=/path/to/session.jsonl` to reattach a specific persisted
session. It sends `get_state` and `get_entries` after connecting, so a relay
or app restart can recover from Pi rather than treating the session as lost.

Enter the same WebSocket URL and token under **Connection** in the app. This
is shared-token authentication, not one-time pairing. The token is stored in
the iOS Keychain; use a development device and a
trusted network, and use a TLS-terminating reverse proxy before exposing the
relay outside localhost. This is shared-token authentication, not a pairing
protocol. The relay does not log tokens, but its bounded history stores
normalized conversation and question text in plaintext in
`.remote-agent-state.json` (ignored by git). Live command envelopes are not
stored directly; Pi rehydrated history is.

## Checks

```sh
node --test bridge/*.test.mjs relay/server.test.mjs
xcodebuild -project ios/RemoteAgent.xcodeproj -scheme RemoteAgent \
  -destination 'platform=iOS Simulator,id=06E06B2E-05F7-4ED7-BCD8-D89D33F6139F' \
  CODE_SIGNING_ALLOWED=NO build
```

The iOS target is native SwiftUI. Claude Code and Codex are not claimed as
working adapters yet: their directories remain integration seams until a
reliable machine-readable local protocol is selected and tested. Pi RPC's
standard `select`, `confirm`, `input`, and `editor` dialogs are supported;
normalized multi-select is reserved for providers that expose it.
