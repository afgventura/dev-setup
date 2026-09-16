#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StrictJsonlDecoder } from "./jsonl.mjs";
import { PiMessageState } from "./message-state.mjs";
import { messageRecords } from "./rehydrate.mjs";
import { OutstandingQuestion } from "./question-state.mjs";
import { PendingQuestionResolutions } from "./timeout-resolutions.mjs";
import { normalizePiEvent } from "./normalize.mjs";

const relayURL = process.env.RELAY_URL ?? "ws://127.0.0.1:8765";
const token = process.env.RELAY_TOKEN;
const sessionId = process.env.PI_SESSION_ID ?? randomUUID();
if (!token) throw new Error("RELAY_TOKEN is required");

const pi = spawn(process.env.PI_BIN ?? "pi", ["--mode", "rpc", ...(process.env.PI_SESSION ? ["--session", process.env.PI_SESSION] : [])], { stdio: ["pipe", "pipe", "inherit"] });
const decoder = new StrictJsonlDecoder();
let socket;
let closing = false;
let authenticated = false;
let lastEntryId;
const messageState = new PiMessageState();
const pendingTimeoutResolutions = new PendingQuestionResolutions();
const outstandingQuestion = new OutstandingQuestion((questionId) => publish({ type: "question_resolved", questionId }));

function send(value) { if (socket?.readyState !== WebSocket.OPEN) return false; try { socket.send(JSON.stringify(value)); return true; } catch { return false; } }
function piCommand(value) { if (!pi.stdin.destroyed) pi.stdin.write(`${JSON.stringify(value)}\n`); }
function publish(value) {
  if (send({ sessionId, ...value })) return;
  if (value.type === "question_resolved") pendingTimeoutResolutions.add(value.questionId);
}
function publishNormalized(event) { const value = normalizePiEvent(event, sessionId); if (value) publish(value); }

function rehydrateEntries(response) {
  for (const message of messageRecords(response)) publish(message);
  if (response.success && response.data?.leafId) lastEntryId = response.data.leafId;
}
function handlePi(event) {
  if (event.type === "response" && event.id === "rehydrate-entries") rehydrateEntries(event);
  if (event.type === "response" && event.id === "rehydrate-state" && event.success) publish({ type: "state", state: event.data?.isStreaming ? "running" : "idle" });
  if (["agent_start", "turn_start"].includes(event.type)) publishNormalized(event);
  if (event.type === "agent_end") return;
  if (["agent_settled", "compaction_start", "auto_retry_start"].includes(event.type)) publishNormalized(event);
  if (event.type === "auto_retry_end") publish({ type: "state", state: event.success === false ? "error" : "running" });
  if (event.type === "extension_ui_request") { outstandingQuestion.set(event); publishNormalized(event); }
  const message = messageState.consume(event);
  if (message) publish(message);
  if (event.type === "error" || event.type === "extension_error") publish({ type: "state", state: "error", error: event.error ?? "Pi error" });
}
function handleCommand(value) {
  if (value.type === "answer") { piCommand({ type: "extension_ui_response", id: value.questionId, ...(value.answer ?? {}) }); outstandingQuestion.clear(value.questionId); return; }
  if (["prompt", "steer", "follow_up", "abort"].includes(value.type)) piCommand({ type: value.type, message: value.message, id: value.requestId, streamingBehavior: value.streamingBehavior });
}
function setupAfterAuth() {
  send({ type: "subscribe", sessionId });
  pendingTimeoutResolutions.flush((value) => send({ sessionId, ...value }));
  const question = outstandingQuestion.event(sessionId); if (question) send(question);
  piCommand({ type: "get_state", id: "rehydrate-state" });
  piCommand({ type: "get_entries", ...(lastEntryId ? { since: lastEntryId } : {}), id: "rehydrate-entries" });
}
function connectOnce() {
  return new Promise((resolve, reject) => {
    authenticated = false;
    try { socket = new WebSocket(relayURL); } catch (error) { reject(error); return; }
    socket.addEventListener("open", () => send({ type: "authenticate", token, role: "bridge" }));
    socket.addEventListener("message", (event) => {
      let value; try { value = JSON.parse(event.data); } catch { return; }
      if (!authenticated) { if (value.type === "authenticated") { authenticated = true; setupAfterAuth(); } else if (value.type === "error" && value.code === "unauthorized") { socket.close(); reject(new Error("relay unauthorized")); } return; }
      handleCommand(value);
    });
    socket.addEventListener("error", () => { socket.close(); reject(new Error("relay connection failed")); });
    socket.addEventListener("close", () => { socket = undefined; resolve(); });
  });
}
async function run() {
  let delay = 1;
  while (!closing) {
    try { await connectOnce(); delay = 1; } catch { if (closing) break; }
    if (!closing) { await new Promise((resolve) => setTimeout(resolve, delay * 1000)); delay = Math.min(delay * 2, 15); }
  }
}
pi.stdout.on("data", (chunk) => { for (const event of decoder.push(chunk)) handlePi(event); });
pi.once("exit", () => { closing = true; socket?.close(); });
process.once("SIGINT", () => { closing = true; socket?.close(); pi.kill("SIGTERM"); });
run();
