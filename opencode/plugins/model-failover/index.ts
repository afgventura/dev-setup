/** HTTP failover for compatible DeepSeek endpoints. No session-switch retries. */
import { appendFileSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { Model, Plugin, Provider } from "@opencode/plugin"
import { forward, type Route } from "./transport"
import { requestState } from "./request-state"

export default Plugin.define({
  id: "model-failover",
  async setup(ctx) {
    const options = ctx.options
    const routes = (options.routes ?? []) as Route[]
    const autoProviderID = Provider.ID.make("auto")
    const autoModelID = Model.ID.make("deepseek-v4.1-flash")
      await ctx.provider.transform((editor) => {
        const source = editor.get("opencode")
        const sourceModel = source?.models.get("deepseek-v4.1-flash-free")
        if (!source || !sourceModel) return
        editor.add({
          info: { ...source.provider, id: autoProviderID, name: "Auto" },
          models: [{
            ...sourceModel, providerID: autoProviderID, id: autoModelID,
            name: "DeepSeek V4.1 Flash",
          }],
        })
      })
    const { pending } = requestState
    const log = (message: string) => {
      if (typeof options.logFile !== "string") return
      try { appendFileSync(options.logFile, `${new Date().toISOString()} http-v2 ${message}\n`) } catch {}
    }
    const index = (model: { providerID: string; id: string }) =>
      model.providerID === autoProviderID && model.id === autoModelID ? 0 : -1

    const resolve = async (route: Route) => {
      const config = JSON.parse(readFileSync(`${homedir()}/.config/opencode/opencode.json`, "utf8"))
      const settings = config.providers?.[route.providerID]?.settings ?? {}
      let apiKey = settings.apiKey
      if (typeof apiKey === "string") {
        apiKey = apiKey.replace(/\{env:([^}]+)\}/g, (_match: string, name: string) => process.env[name] ?? "")
      }
      if (!apiKey && route.providerID === "opencode-go") {
        try {
          const credentials = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"))
          apiKey = credentials["opencode-go"]?.key
        } catch {}
        apiKey ??= process.env.OPENCODE_API_KEY
      }
      const defaults: Record<string, string> = {
        opencode: "https://opencode.ai/inference/openai/v1",
        "opencode-go": "https://opencode.ai/inference/go/openai/v1",
      }
      const baseURL = settings.baseURL ?? defaults[route.providerID]
      if (typeof baseURL !== "string" || typeof apiKey !== "string" || !apiKey) return undefined
      return { baseURL, apiKey }
    }

    await ctx.session.hook("http.request", async (event) => {
      if (index(event.model) < 0 || event.kind === "title") return
      event.request.headers.set("x-opencode-session", event.sessionID)
      pending.set(event.request, await event.request.clone().text())
    })
    await ctx.session.hook("http.response", async (event) => {
      const start = index(event.model)
      if (start < 0 || event.kind === "title") return
      const body = pending.get(event.request)
      pending.delete(event.request)
      if (body === undefined) {
        log(`session=${event.sessionID} request body unavailable status=${event.response.status}`)
        return
      }
      event.response = await forward({
        response: event.response, request: event.request, body, routes, start, resolve,
        log: (message) => log(`session=${event.sessionID} ${message}`),
      })
    })
    await ctx.session.hook("retry", (event) => {
      if (index(event.model) >= 0) event.decision = { retry: false }
    })
    log(`loaded routes=${routes.map((route) => `${route.providerID}/${route.modelID}`).join(" -> ")}`)
  },
})
