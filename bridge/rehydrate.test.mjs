import test from "node:test";
import assert from "node:assert/strict";
import { messageRecords } from "./rehydrate.mjs";

test("rehydration uses durable entry IDs and is idempotent across reconnects", () => {
  const response = { success: true, data: { leafId: "a2", entries: [{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }, { id: "a2", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }] } };
  const first = messageRecords(response); const second = messageRecords(response);
  assert.deepEqual(first, second); assert.deepEqual(first.map((value) => value.messageId), ["u1", "a2"]);
});

test("rehydration extracts string content and advances over a non-message leaf", () => {
  const response = { success: true, data: { leafId: "tool", entries: [{ id: "u1", type: "message", message: { role: "user", content: "hi" } }, { id: "tool", parentId: "u1", type: "tool", payload: "ignored" }] } };
  assert.deepEqual(messageRecords(response), [{ messageId: "u1", role: "user", text: "hi", streaming: false }]);
  assert.equal(response.data.leafId, "tool");
});
