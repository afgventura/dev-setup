import { Plugin } from "@opencode/plugin/tui"
import { LoopRpc, type LoopStatus } from "./rpc"

/**
 * Footer status for the loop plugin: the running interval loop or the pending
 * wake-up of the current session. Reads state from the server plugin over RPC.
 */

function labelFor(entry: LoopStatus | undefined): string | undefined {
  if (!entry) return undefined
  if (entry.loop) return `↻ ${entry.loop.label} #${entry.loop.runs}`
  if (entry.wakeup) {
    const at = new Date(entry.wakeup.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    return `⏰ ${at}${entry.wakeup.reason ? ` · ${entry.wakeup.reason}` : ""}`
  }
  return undefined
}

export default Plugin.define({
  id: "gery.loop.tui",
  setup(context) {
    const rpc = context.client.rpc(LoopRpc)
    const [state, setState] = context.storage.memory("loop-status", { initial: {} as Record<string, LoopStatus> })
    const requested = new Set<string>()

    // Fetch once per session so a loop armed before this TUI opened is visible.
    const refresh = (sessionID: string): void => {
      if (requested.has(sessionID)) return
      requested.add(sessionID)
      rpc
        .status({ sessionID })
        .then((result) => {
          setState((draft) => {
            draft[sessionID] = result as unknown as LoopStatus
          })
        })
        .catch(() => {
          requested.delete(sessionID)
        })
    }

    const off = rpc.events.on("changed", (event) => {
      const data = event.data as unknown as LoopStatus
      if (!data?.sessionID) return
      requested.add(data.sessionID)
      setState((draft) => {
        draft[data.sessionID] = data
      })
    })

    const unregister = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = input.sessionID
        if (!sessionID) return <></>
        refresh(sessionID)
        const label = labelFor(state[sessionID])
        if (!label) return <></>
        return <text fg={context.theme.text.base}>{label}</text>
      },
    })

    return () => {
      off()
      unregister()
    }
  },
})
