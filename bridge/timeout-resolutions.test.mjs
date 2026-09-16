import test from "node:test";
import assert from "node:assert/strict";
import { PendingQuestionResolutions } from "./timeout-resolutions.mjs";

test("buffers offline timeout resolutions and flushes them after reconnect", () => {
  const pending = new PendingQuestionResolutions();
  pending.add("q-offline");
  const sent = [];
  pending.flush(() => false);
  assert.equal(pending.size, 1);
  pending.flush((value) => { sent.push(value); return true; });
  assert.deepEqual(sent, [{ type: "question_resolved", questionId: "q-offline" }]);
  assert.equal(pending.size, 0);
});
