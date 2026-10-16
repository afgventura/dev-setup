import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Exercise the plugin without an OpenCode service or model calls.
test("resume blocked goals without bypassing pause or budget limits", async () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.replace(/^import .*$/gm, "").replace("export default Plugin.define", "return Plugin.define"),
  )
  const plugin = new Function("Plugin", "GoalRpc", code)({ define: (value: unknown) => value }, {})
  const tools = new Map()
  const hooks = new Map()
  const storage = new Map()
  const changes: unknown[] = []
  const prompts: unknown[] = []
  const registration = { dispose: async () => {} }
  let tokens = 0
  let duringRead: (() => void) | undefined
  const cleanup = await plugin.setup({
    tool: { transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); return registration } },
    command: { transform: async () => registration },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => { storage.set(key, structuredClone(value)) },
      remove: async (key) => { storage.delete(key) },
    },
    session: {
      get: async () => { duringRead?.(); return { tokens: { input: tokens } } },
      hook: async (name, callback) => { hooks.set(name, callback); return registration },
      synthetic: async () => {},
      prompt: async (input) => { prompts.push(input) },
    },
    rpc: { register: async () => ({ ...registration, events: { emit: async (...args) => { changes.push(args) } } }) },
    event: { subscribe: async function* () {} },
  })
  const sessionID = `resume-test-${crypto.randomUUID()}`
  const invoke = (input) => tools.get("update_goal").execute(input, { sessionID })
  try {
    expect(tools.get("update_goal").input.properties.status.enum).toContain("active")
    expect((await invoke({ status: "active", reasoning: "Resolved" })).content).toContain("no goal")
    await tools.get("create_goal").execute({ objective: "Check scope", token_budget: 100 }, { sessionID })
    await invoke({ status: "blocked", reasoning: "Await scope" })
    const before = storage.get(`goal/${sessionID}`)
    expect((await invoke({ status: "active" })).content).toContain("supply reasoning")
    const context = { sessionID, system: [] }
    await hooks.get("context")(context)
    expect(context.system[0].text).toContain('status "active"')
    expect((await invoke({ status: "active", reasoning: "The user approved all users." })).content).toContain("resumed")
    const after = storage.get(`goal/${sessionID}`)
    expect(after.status).toBe("active")
    for (const field of ["id", "objective", "tokensBase", "tokenBudget", "timeUsedMs", "createdAt"]) {
      expect(after[field]).toEqual(before[field])
    }
    expect(changes.at(-1)[1].goal.status).toBe("active")
    expect(prompts).toHaveLength(0)
    expect((await invoke({ status: "active", reasoning: "Repeat" })).content).toContain("Only blocked goals")
    await invoke({ status: "paused" })
    expect((await invoke({ status: "active", reasoning: "Resolved" })).metadata.status).toBe("paused")
    await invoke({ status: "blocked" })
    tokens = 100
    expect((await invoke({ status: "active", reasoning: "Resolved" })).content).toContain("budget is exhausted")
    tokens = 0
    duringRead = () => { duringRead = undefined; void invoke({ status: "paused" }) }
    expect((await invoke({ status: "active", reasoning: "Resolved" })).content).toContain("changed during")
    duringRead = undefined
    await invoke({ status: "complete" })
    expect((await invoke({ status: "active", reasoning: "Resolved" })).metadata.status).toBe("complete")
  } finally {
    await cleanup()
  }
})
