export class OutstandingQuestion {
  #value;
  #timer;
  #onExpire;
  constructor(onExpire = () => {}) { this.#onExpire = onExpire; }
  set(value) {
    if (!["select", "confirm", "input", "editor"].includes(value.method)) return;
    this.clear();
    this.#value = value;
    if (Number.isFinite(value.timeout) && value.timeout >= 0) {
      const id = value.id;
      this.#timer = setTimeout(() => { this.#timer = undefined; this.#onExpire(id); this.clear(id); }, value.timeout);
    }
  }
  clear(id) {
    if (id && this.#value?.id !== id) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#value = undefined;
  }
  event(sessionId) { if (!this.#value) return null; const value = this.#value; return { sessionId, type: "question", questionId: value.id, kind: { select: "choice", confirm: "confirmation", input: "input", editor: "editor" }[value.method], title: value.title ?? "Pi asks", message: value.message, options: value.options, placeholder: value.placeholder, prefill: value.prefill }; }
}
