import test from "node:test";
import assert from "node:assert/strict";
import { OutstandingQuestion } from "./question-state.mjs";

test("retains response-required Pi UI requests across reconnect and clears answers", () => {
  const state = new OutstandingQuestion(); state.set({ id: "q1", method: "editor", prefill: "draft" });
  assert.equal(state.event("s").prefill, "draft"); state.clear("q1"); assert.equal(state.event("s"), null);
});

test("expires timed-out dialogs and cancels the replaced question timer", async () => {
  const state = new OutstandingQuestion();
  state.set({ id: "old", method: "input", timeout: 15 });
  state.set({ id: "new", method: "confirm", timeout: 35 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.event("s").questionId, "new");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(state.event("s"), null);
});

test("notifies the bridge when a timed-out question expires", async () => {
  const expired = [];
  const state = new OutstandingQuestion((id) => expired.push(id));
  state.set({ id: "q-timeout", method: "confirm", timeout: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(expired, ["q-timeout"]);
  assert.equal(state.event("s"), null);
});
