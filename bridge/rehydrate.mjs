export function currentBranch(entries, leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry])); const branch = [];
  for (let id = leafId; id && byId.has(id); id = byId.get(id).parentId) branch.unshift(byId.get(id));
  return branch;
}
export function messageRecords(response) {
  if (!response.success) return [];
  return currentBranch(response.data?.entries ?? [], response.data?.leafId).filter((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message?.role)).map((entry) => ({ messageId: entry.id, role: entry.message.role, text: textContent(entry.message.content), streaming: false }));
}
export function textContent(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}
