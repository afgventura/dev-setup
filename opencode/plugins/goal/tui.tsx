import { Plugin } from "@opencode/plugin/tui"
import { GoalRpc, type GoalStatus } from "./rpc"

/**
 * Goal display for the goal plugin: a footer status line with the objective,
 * status and token usage, plus a sidebar widget with the full objective.
 * Reads state from the server plugin over RPC.
 */

type Theme = { text: { base: unknown; muted: unknown; feedback: Record<string, { base: unknown }> } }

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function statusLabel(status: string): string {
  return status === "budget_limited" ? "budget limited" : status
}

function colorFor(status: string, theme: Theme): unknown {
  switch (status) {
    case "complete":
      return theme.text.feedback.success?.base ?? theme.text.base
    case "blocked":
    case "budget_limited":
      return theme.text.feedback.warning?.base ?? theme.text.base
    case "paused":
      return theme.text.muted
    default:
      return theme.text.base
  }
}

function footerText(goal: GoalStatus["goal"]): string | undefined {
  if (!goal) return undefined
  const flat = goal.objective.replace(/\s+/g, " ").trim()
  const short = flat.length <= 30 ? flat : `${flat.slice(0, 29)}…`
  const tokens = goal.tokenBudget === undefined ? formatTokens(goal.tokensUsed) : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`
  return `🎯 ${short} · ${statusLabel(goal.status)} · ${tokens}`
}

export default Plugin.define({
  id: "gery.goal.tui",
  setup(context) {
    const theme = context.theme as unknown as Theme
    const rpc = context.client.rpc(GoalRpc)
    const [state, setState] = context.storage.memory("goal-status", { initial: {} as Record<string, GoalStatus> })
    const requested = new Set<string>()

    const refresh = (sessionID: string): void => {
      if (requested.has(sessionID)) return
      requested.add(sessionID)
      rpc
        .status({ sessionID })
        .then((result) => {
          setState((draft) => {
            draft[sessionID] = result as unknown as GoalStatus
          })
        })
        .catch(() => {
          requested.delete(sessionID)
        })
    }

    const off = rpc.events.on("changed", (event) => {
      const data = event.data as unknown as GoalStatus
      if (!data?.sessionID) return
      requested.add(data.sessionID)
      setState((draft) => {
        draft[data.sessionID] = data
      })
    })

    const footer = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = input.sessionID
        if (!sessionID) return <></>
        refresh(sessionID)
        const goal = state[sessionID]?.goal
        const text = footerText(goal)
        if (!text || !goal) return <></>
        return <text fg={colorFor(goal.status, theme)}>{text}</text>
      },
    })

    const widget = context.ui.slot({
      append: "sidebar.footer",
      render: (input) => {
        const goal = state[input.sessionID]?.goal
        if (!goal) return <></>
        return (
          <>
            <text fg={colorFor(goal.status, theme)}>{`🎯 ${statusLabel(goal.status)} · ${goal.id}`}</text>
            <text fg={theme.text.base}>{goal.objective.split("\n")[0]}</text>
          </>
        )
      },
    })

    return () => {
      off()
      footer()
      widget()
    }
  },
})
