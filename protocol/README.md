# Remote agent protocol

The relay protocol is one UTF-8 JSON object per WebSocket message. It is not
JSONL and has no newline framing requirement. Clients authenticate first with
`{"type":"authenticate","token":"…","role":"app|bridge"}`.

Pi's child-process RPC protocol is separate strict-LF JSONL. Every Pi stdin or
stdout record ends in one LF (`\n`); CRLF input is accepted and the trailing
CR is removed. Unicode line separators are valid JSON string contents.

The bridge publishes `hello`, `snapshot`, `state`, `message`, `question`,
`notification`, and `error` records. Clients send `subscribe`, `prompt`,
`steer`, `follow_up`, `abort`, and `answer` records. Each published record has
`sessionId` and a monotonically increasing `sequence`; clients may acknowledge
with `ack`. Duplicate or older sequences are ignored by both clients and the
relay.

Pi is the first-class adapter. It runs `pi --mode rpc` with its normal session
directory and forwards the documented RPC JSONL protocol, including streaming
events and `extension_ui_request`/`extension_ui_response`. The bridge uses
`get_state` and stable-cursor `get_entries` after reconnect so a relay or app
restart can rehydrate from Pi's persisted session. No PTY fallback is used.

`select`, `confirm`, `input`, and `editor` are normalized as questions. The
normalized protocol also permits `multi_select` for providers that support it;
standard Pi RPC currently exposes the four documented dialog methods above.
