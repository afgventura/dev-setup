import test from "node:test";
import assert from "node:assert/strict";
import { normalizePiEvent } from "./normalize.mjs";

test("normalizes Pi state and dialog events without tool detail", () => {
  assert.deepEqual(normalizePiEvent({ type: "agent_settled" }, "s"), { sessionId: "s", type: "state", state: "idle" });
  assert.equal(normalizePiEvent({ type: "tool_execution_end", result: "secret" }, "s"), null);
  assert.deepEqual(normalizePiEvent({ type: "agent_end" }, "s"), null);
  assert.equal(normalizePiEvent({ type: "extension_ui_request", id: "q", method: "editor", prefill: "draft" }, "s").prefill, "draft");
});
