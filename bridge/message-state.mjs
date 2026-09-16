import { randomUUID } from "node:crypto";

export class PiMessageState {
  #activeId;
  consume(event) {
    if (event.type === "message_start" && event.message?.role === "assistant") this.#activeId = event.message.id ?? randomUUID();
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") return { type: "message", messageId: this.#activeId ?? randomUUID(), role: "assistant", text: event.assistantMessageEvent.delta ?? "", streaming: true, delta: true };
    if (event.type === "message_end" && event.message?.role === "assistant") { const value = { type: "message", messageId: this.#activeId ?? event.message.id ?? randomUUID(), role: "assistant", text: (event.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join(""), streaming: false }; this.#activeId = undefined; return value; }
    return null;
  }
}
