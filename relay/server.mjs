#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const port = Number(process.env.RELAY_PORT ?? 8765);
const expectedToken = process.env.RELAY_TOKEN;
const stateFile = process.env.RELAY_STATE ?? ".remote-agent-state.json";
if (!expectedToken) throw new Error("RELAY_TOKEN is required");

const peers = new Set();
const sessions = new Map();
const bridgeEventTypes = new Set(["state", "message", "question", "notification", "error", "question_resolved"]);
const sameToken = (actual) => {
  const a = Buffer.from(actual ?? "");
  const b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b);
};
const getSession = (id) => {
  if (!sessions.has(id)) sessions.set(id, { sessionId: id, sequence: 0, events: [], owner: null, clients: new Set() });
  return sessions.get(id);
};
async function restore() {
  try {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    for (const value of saved) sessions.set(value.sessionId, { ...value, owner: null, clients: new Set() });
  } catch { /* first run */ }
}
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFile(stateFile, JSON.stringify([...sessions.values()].map(({ owner, clients, ...value }) => value), null, 2)).catch((error) => console.error(`relay state write failed: ${error.message}`)), 50);
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const header = Buffer.alloc(body.length < 65536 ? 4 : 10);
  header[0] = 0x81; header[1] = body.length < 65536 ? 126 : 127;
  if (body.length < 65536) header.writeUInt16BE(body.length, 2); else header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}
function controlFrame(opcode, payload = Buffer.alloc(0)) { return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]); }
function send(peer, value) { if (!peer.socket.destroyed) peer.socket.write(frame(value)); }
function publish(session, event, persistEvent = true) {
  const value = { ...event, sessionId: session.sessionId, sequence: ++session.sequence };
  if (persistEvent) session.events = [...session.events.slice(-199), value];
  persist();
  for (const peer of session.clients) send(peer, value);
}
function rejectBridgeEvent(peer, message) {
  send(peer, { type: "error", code: "bridge_session_mismatch", message });
}
function handle(peer, value) {
  if (!peer.authenticated) {
    if (value.type !== "authenticate" || !sameToken(value.token) || !["app", "bridge"].includes(value.role)) {
      send(peer, { type: "error", code: "unauthorized", message: "authenticate with a valid token first" });
      peer.socket.end();
      return;
    }
    peer.authenticated = true; peer.role = value.role;
    send(peer, { type: "authenticated" });
    return;
  }
  if (value.type === "list_sessions" && peer.role === "app") {
    send(peer, { type: "sessions", sessions: [...sessions.values()].map(({ sessionId, sequence, owner }) => ({ sessionId, sequence, online: Boolean(owner && !owner.socket.destroyed) })) });
    return;
  }
  if (value.type === "subscribe") {
    const session = getSession(value.sessionId);
    if (peer.role === "bridge" && session.owner && session.owner !== peer && !session.owner.socket.destroyed) {
      send(peer, { type: "error", code: "session_owned", sessionId: session.sessionId, message: "session already has a live bridge owner" });
      return;
    }
    session.clients.add(peer); peer.sessions.add(session.sessionId);
    if (peer.role === "bridge") session.owner = peer;
    send(peer, { type: "snapshot", sessionId: session.sessionId, sequence: session.sequence, events: session.events });
    return;
  }
  if (value.type === "ack") return;
  if (peer.role === "bridge" && bridgeEventTypes.has(value.type)) {
    const session = sessions.get(value.sessionId);
    if (!session || session.owner !== peer) {
      rejectBridgeEvent(peer, "bridge may publish only to its owned subscribed session");
      return;
    }
    const persistEvent = ["message", "question", "question_resolved"].includes(value.type);
    publish(session, value, persistEvent);
    return;
  }
  if (peer.role === "bridge" && value.sessionId) {
    rejectBridgeEvent(peer, "unsupported bridge event");
    return;
  }
  if (peer.role === "app" && ["prompt", "steer", "follow_up", "abort", "answer"].includes(value.type)) {
    const session = sessions.get(value.sessionId);
    if (!session?.owner || session.owner.socket.destroyed) {
      send(peer, { type: "error", code: "session_unavailable", sessionId: value.sessionId, message: "no bridge is online for this session" });
      return;
    }
    send(session.owner, value);
    if (value.type === "answer") publish(session, { type: "question_resolved", questionId: value.questionId });
    else if (value.type !== "abort") publish(session, { type: "message", messageId: value.requestId ?? randomUUID(), role: "user", text: value.message ?? "" }, false);
  }
}
function parseFrames(peer, chunk) {
  peer.buffer = Buffer.concat([peer.buffer, chunk]);
  while (peer.buffer.length >= 2) {
    const first = peer.buffer[0]; const marker = peer.buffer[1]; const fin = Boolean(first & 128); const opcode = first & 15; let length = marker & 127; let offset = 2;
    if ((first & 0x70) !== 0 || (marker & 128) === 0) { peer.socket.end(); return; }
    if (length === 126) { if (peer.buffer.length < 4) return; length = peer.buffer.readUInt16BE(2); offset = 4; }
    if (length === 127) { if (peer.buffer.length < 10) return; const wideLength = peer.buffer.readBigUInt64BE(2); if (wideLength > 1024n * 1024n) { peer.socket.end(); return; } length = Number(wideLength); offset = 10; }
    if (opcode >= 8 && (!fin || length > 125)) { peer.socket.end(); return; }
    if (peer.buffer.length < offset + length + 4) return;
    const masked = Boolean(marker & 128); let data = peer.buffer.subarray(offset + (masked ? 4 : 0), offset + (masked ? 4 : 0) + length);
    if (!masked) { peer.socket.end(); return; }
    if (masked) { const key = peer.buffer.subarray(offset, offset + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= key[i % 4]; }
    peer.buffer = peer.buffer.subarray(offset + (masked ? 4 : 0) + length);
    if (opcode === 8) { peer.socket.write(controlFrame(8, data)); peer.socket.end(); return; }
    if (opcode === 9) { peer.socket.write(controlFrame(10, data)); continue; }
    if (opcode === 2 || (opcode === 0 && !peer.fragment) || (opcode === 1 && peer.fragment)) { peer.socket.end(); return; }
    if (opcode === 1 && !fin) peer.fragment = Buffer.alloc(0);
    if (opcode === 1 || opcode === 0) {
      const total = (peer.fragment?.length ?? 0) + data.length;
      if (total > 1024 * 1024) { peer.socket.end(); return; }
      if (!fin) { peer.fragment = Buffer.concat([peer.fragment ?? Buffer.alloc(0), data]); continue; }
      const message = peer.fragment ? Buffer.concat([peer.fragment, data]) : data;
      peer.fragment = undefined;
      try { handle(peer, JSON.parse(message.toString("utf8"))); } catch { send(peer, { type: "error", code: "invalid_json", message: "invalid JSON message" }); }
    }
  }
}
const server = createServer((_, response) => { response.writeHead(200); response.end("remote-agent-relay\n"); });
server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const peer = { socket, buffer: Buffer.alloc(0), fragment: undefined, authenticated: false, role: null, sessions: new Set() };
  peers.add(peer);
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("data", (chunk) => parseFrames(peer, chunk));
  socket.on("close", () => { peers.delete(peer); for (const id of peer.sessions) { const session = sessions.get(id); session?.clients.delete(peer); if (session?.owner === peer) session.owner = null; } });
  socket.on("error", () => socket.destroy());
});
await restore();
server.listen(port, () => console.log(`relay listening on ws://127.0.0.1:${port}`));
