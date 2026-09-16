import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 19000 + Math.floor(Math.random() * 500);
let child;
let root;
const token = "focused-test-token";
const trackedSockets = new Set();
const waitTimeoutMs = 2000;

function waitForMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { clearTimeout(timer); socket.removeEventListener("message", onMessage); socket.removeEventListener("error", onError); callback(value); };
    const onMessage = (event) => { try { const value = JSON.parse(event.data); if (predicate(value)) finish(resolve, value); } catch (error) { finish(reject, error); } };
    const onError = (error) => finish(reject, error);
    const timer = setTimeout(() => finish(reject, new Error(`timed out waiting for WebSocket message after ${waitTimeoutMs}ms`)), waitTimeoutMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
  });
}
async function connect(role) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  trackedSockets.add(socket);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const authenticated = waitForMessage(socket, (value) => value.type === "authenticated");
  socket.send(JSON.stringify({ type: "authenticate", token, role }));
  await authenticated;
  return socket;
}

function rawFrame(payload, { fin = true, opcode = 1 } = {}) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (body.length < 126) header[1] = 0x80 | body.length;
  else { header[1] = 0x80 | 126; header.writeUInt16BE(body.length, 2); }
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

async function rawConnect(role) {
  const socket = createConnection(port, "127.0.0.1");
  trackedSockets.add(socket);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdC1yYXctcGVlcg==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let buffered = Buffer.alloc(0);
  while (!buffered.includes(Buffer.from("\r\n\r\n"))) buffered = Buffer.concat([buffered, await new Promise((resolve) => socket.once("data", resolve))]);
  socket.write(rawFrame(JSON.stringify({ type: "authenticate", token, role })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return socket;
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED || socket.destroyed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, waitTimeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    if (typeof socket.addEventListener === "function") { socket.addEventListener("close", done, { once: true }); socket.close(); }
    else { socket.once("close", done); socket.end(); }
  });
}

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), "remote-agent-relay-"));
  child = spawn(process.execPath, ["relay/server.mjs"], { env: { ...process.env, RELAY_TOKEN: token, RELAY_PORT: String(port), RELAY_STATE: join(root, "state.json") }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
});
test.after(async () => {
  await Promise.all([...trackedSockets].map(closeSocket));
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitTimeoutMs);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }
  await rm(root, { recursive: true, force: true });
});

test("rejects non-authenticated peers and closes them", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  trackedSockets.add(socket);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const errorMessage = waitForMessage(socket, (value) => value.type === "error");
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "list_sessions" }));
  const error = await errorMessage;
  assert.equal(error.code, "unauthorized");
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("unauthorized socket did not close")), waitTimeoutMs))]);
});

test("routes commands only to the owning bridge and does not persist prompt text", async () => {
  const app = await connect("app");
  const first = await connect("bridge");
  const second = await connect("bridge");
  let secondReceivedPrompt = false;
  second.addEventListener("message", (event) => { if (JSON.parse(event.data).type === "prompt") secondReceivedPrompt = true; });
  const firstSnapshot = waitForMessage(first, (v) => v.type === "snapshot" && v.sessionId === "one");
  const secondSnapshot = waitForMessage(second, (v) => v.type === "snapshot" && v.sessionId === "two");
  first.send(JSON.stringify({ type: "subscribe", sessionId: "one" }));
  second.send(JSON.stringify({ type: "subscribe", sessionId: "two" }));
  await Promise.all([firstSnapshot, secondSnapshot]);
  const appSnapshot = waitForMessage(app, (v) => v.type === "snapshot" && v.sessionId === "one");
  app.send(JSON.stringify({ type: "subscribe", sessionId: "one" }));
  await appSnapshot;
  const routedPrompt = waitForMessage(first, (v) => v.type === "prompt");
  app.send(JSON.stringify({ type: "prompt", sessionId: "one", requestId: "r1", message: "private prompt" }));
  const routed = await routedPrompt;
  assert.equal(routed.message, "private prompt");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(secondReceivedPrompt, false);
  const saved = await readFile(join(root, "state.json"), "utf8");
  assert.equal(saved.includes("private prompt"), false);
  app.close(); first.close(); second.close();
});

test("persists question resolutions for fresh snapshot replay", async () => {
  const app = await connect("app");
  const bridge = await connect("bridge");
  const bridgeSnapshot = waitForMessage(bridge, (value) => value.type === "snapshot" && value.sessionId === "answered-question");
  bridge.send(JSON.stringify({ type: "subscribe", sessionId: "answered-question" }));
  await bridgeSnapshot;
  const forwardedAnswer = waitForMessage(bridge, (value) => value.type === "answer");
  const resolvedAnswer = waitForMessage(bridge, (value) => value.type === "question_resolved" && value.questionId === "q1");
  app.send(JSON.stringify({ type: "answer", sessionId: "answered-question", questionId: "q1", answer: { value: "yes" } }));
  const forwarded = await forwardedAnswer;
  assert.equal(forwarded.questionId, "q1");
  await resolvedAnswer;
  await new Promise((resolve) => setTimeout(resolve, 100));
  app.close(); bridge.close();
  const replay = await connect("app");
  const replaySnapshot = waitForMessage(replay, (value) => value.type === "snapshot" && value.sessionId === "answered-question");
  replay.send(JSON.stringify({ type: "subscribe", sessionId: "answered-question" }));
  const snapshot = await replaySnapshot;
  assert.deepEqual(snapshot.events.map((value) => value.type), ["question_resolved"]);
  replay.close();
});

test("reconstructs a fragmented authenticated command and routes it once", async () => {
  const app = await rawConnect("app");
  const bridge = await connect("bridge");
  const bridgeSnapshot = waitForMessage(bridge, (value) => value.type === "snapshot" && value.sessionId === "fragmented-command");
  bridge.send(JSON.stringify({ type: "subscribe", sessionId: "fragmented-command" }));
  await bridgeSnapshot;
  const routedPrompt = waitForMessage(bridge, (value) => value.type === "prompt");
  app.write(rawFrame(JSON.stringify({ type: "prompt", sessionId: "fragmented-command", requestId: "fragmented-1", message: "hello" }).slice(0, 48), { fin: false }));
  app.write(rawFrame(JSON.stringify({ type: "prompt", sessionId: "fragmented-command", requestId: "fragmented-1", message: "hello" }).slice(48), { fin: true, opcode: 0 }));
  const routed = await routedPrompt;
  assert.equal(routed.requestId, "fragmented-1");
  let routedAgain = false;
  const onMessage = (event) => { if (JSON.parse(event.data).type === "prompt") routedAgain = true; };
  bridge.addEventListener("message", onMessage);
  await new Promise((resolve) => setTimeout(resolve, 100));
  bridge.removeEventListener("message", onMessage);
  assert.equal(routedAgain, false);
  app.end(); bridge.close();
});

test("routes only owned bridge events, replays question resolution, and does not publish abort text", async () => {
  const appOne = await connect("app");
  const appTwo = await connect("app");
  const bridgeOne = await connect("bridge");
  const bridgeTwo = await connect("bridge");
  const bridgeOneSnapshot = waitForMessage(bridgeOne, (value) => value.type === "snapshot" && value.sessionId === "bridge-one");
  const bridgeTwoSnapshot = waitForMessage(bridgeTwo, (value) => value.type === "snapshot" && value.sessionId === "bridge-two");
  bridgeOne.send(JSON.stringify({ type: "subscribe", sessionId: "bridge-one" }));
  bridgeTwo.send(JSON.stringify({ type: "subscribe", sessionId: "bridge-two" }));
  await Promise.all([bridgeOneSnapshot, bridgeTwoSnapshot]);
  const appOneSnapshot = waitForMessage(appOne, (value) => value.type === "snapshot" && value.sessionId === "bridge-one");
  const appTwoSnapshot = waitForMessage(appTwo, (value) => value.type === "snapshot" && value.sessionId === "bridge-two");
  appOne.send(JSON.stringify({ type: "subscribe", sessionId: "bridge-one" }));
  appTwo.send(JSON.stringify({ type: "subscribe", sessionId: "bridge-two" }));
  await Promise.all([appOneSnapshot, appTwoSnapshot]);
  let leaked = false;
  appTwo.addEventListener("message", (event) => { const value = JSON.parse(event.data); if (["state", "message", "question", "notification", "error", "question_resolved"].includes(value.type)) leaked = true; });
  const stateEvent = waitForMessage(appOne, (value) => value.type === "state" && value.state === "running");
  const messageEvent = waitForMessage(appOne, (value) => value.type === "message" && value.messageId === "m1");
  const questionEvent = waitForMessage(appOne, (value) => value.type === "question" && value.questionId === "q-timeout");
  bridgeOne.send(JSON.stringify({ sessionId: "bridge-one", type: "state", state: "running" }));
  bridgeOne.send(JSON.stringify({ sessionId: "bridge-one", type: "message", messageId: "m1", role: "assistant", text: "hello", streaming: false }));
  bridgeOne.send(JSON.stringify({ sessionId: "bridge-one", type: "question", questionId: "q-timeout", kind: "confirmation", title: "Confirm", message: "Continue?" }));
  await Promise.all([stateEvent, messageEvent, questionEvent]);
  const rejectedEvent = waitForMessage(bridgeTwo, (value) => value.type === "error" && value.code === "bridge_session_mismatch");
  bridgeTwo.send(JSON.stringify({ sessionId: "bridge-one", type: "message", messageId: "injected", role: "assistant", text: "bad" }));
  const rejected = await rejectedEvent;
  assert.equal(rejected.code, "bridge_session_mismatch");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(leaked, false);
  const resolvedEvent = waitForMessage(appOne, (value) => value.type === "question_resolved" && value.questionId === "q-timeout");
  bridgeOne.send(JSON.stringify({ sessionId: "bridge-one", type: "question_resolved", questionId: "q-timeout" }));
  await resolvedEvent;
  const abortApp = await connect("app");
  const abortSnapshot = waitForMessage(abortApp, (value) => value.type === "snapshot" && value.sessionId === "bridge-one");
  abortApp.send(JSON.stringify({ type: "subscribe", sessionId: "bridge-one" }));
  await abortSnapshot;
  const abortForwarded = waitForMessage(bridgeOne, (value) => value.type === "abort" && value.requestId === "abort-1");
  abortApp.send(JSON.stringify({ type: "abort", sessionId: "bridge-one", requestId: "abort-1" }));
  await abortForwarded;
  await new Promise((resolve) => setTimeout(resolve, 80));
  abortApp.close(); appOne.close(); appTwo.close(); bridgeOne.close(); bridgeTwo.close();
  const replay = await connect("app");
  const replaySnapshot = waitForMessage(replay, (value) => value.type === "snapshot" && value.sessionId === "bridge-one");
  replay.send(JSON.stringify({ type: "subscribe", sessionId: "bridge-one" }));
  const snapshot = await replaySnapshot;
  assert.deepEqual(snapshot.events.filter((value) => value.questionId === "q-timeout").map((value) => value.type), ["question", "question_resolved"]);
  assert.equal(snapshot.events.some((value) => value.type === "message" && value.messageId === "abort-1" && value.text === ""), false);
  replay.close();
});

test("rejects a second bridge from taking over a live owned session", async () => {
  const first = await connect("bridge");
  const second = await connect("bridge");
  const app = await connect("app");
  const firstSnapshot = waitForMessage(first, (value) => value.type === "snapshot" && value.sessionId === "owned-session");
  first.send(JSON.stringify({ type: "subscribe", sessionId: "owned-session" }));
  await firstSnapshot;
  const rejectedTakeover = waitForMessage(second, (value) => value.type === "error" && value.code === "session_owned");
  second.send(JSON.stringify({ type: "subscribe", sessionId: "owned-session" }));
  const rejected = await rejectedTakeover;
  assert.equal(rejected.sessionId, "owned-session");
  const appSnapshot = waitForMessage(app, (value) => value.type === "snapshot" && value.sessionId === "owned-session");
  app.send(JSON.stringify({ type: "subscribe", sessionId: "owned-session" }));
  await appSnapshot;
  const stateEvent = waitForMessage(app, (value) => value.type === "state" && value.state === "running");
  first.send(JSON.stringify({ type: "state", sessionId: "owned-session", state: "running" }));
  await stateEvent;
  app.close(); first.close(); second.close();
});
