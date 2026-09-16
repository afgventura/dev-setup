export class PendingQuestionResolutions {
  #ids = new Set();
  add(questionId) { if (questionId) this.#ids.add(questionId); }
  flush(send) {
    for (const questionId of this.#ids) {
      if (!send({ type: "question_resolved", questionId })) break;
      this.#ids.delete(questionId);
    }
  }
  get size() { return this.#ids.size; }
}
