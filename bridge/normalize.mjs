export function normalizePiEvent(value, sessionId) {
  const base = { sessionId };
  if (["agent_start", "turn_start"].includes(value.type)) return { ...base, type: "state", state: "running" };
  if (value.type === "agent_settled") return { ...base, type: "state", state: "idle" };
  if (value.type === "compaction_start") return { ...base, type: "state", state: "compacting" };
  if (value.type === "auto_retry_start") return { ...base, type: "state", state: "retrying" };
  if (value.type === "extension_ui_request") return { ...base, type: "question", questionId: value.id, kind: { select: "choice", confirm: "confirmation", input: "input", editor: "editor" }[value.method] ?? value.method, title: value.title ?? "Pi asks", message: value.message, options: value.options, prefill: value.prefill };
  return null;
}
