import test from "node:test";
import assert from "node:assert/strict";
import { PiMessageState } from "./message-state.mjs";

test("accumulates deltas by stable turn id and finalizes two turns independently", () => {
  const state = new PiMessageState();
  state.consume({ type: "message_start", message: { role: "assistant" } });
  const first = state.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one" } });
  const final = state.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "one!" }] } });
  state.consume({ type: "message_start", message: { role: "assistant" } });
  const second = state.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } });
  assert.equal(first.messageId, final.messageId);
  assert.notEqual(first.messageId, second.messageId);
  assert.equal(final.streaming, false);
});
