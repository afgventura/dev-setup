import { Rpc } from "@opencode/plugin/rpc"

/**
 * State the goal plugin shares with its TUI entry.
 *
 * The server plugin owns the goal; the TUI runs in a separate process, so it
 * reads this state over RPC and follows `changed` events.
 */

const goalSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    objective: { type: "string" },
    status: { type: "string" },
    tokensUsed: { type: "number" },
    tokenBudget: { type: "number" },
    timeUsedSeconds: { type: "number" },
  },
  required: ["id", "objective", "status", "tokensUsed", "timeUsedSeconds"],
  additionalProperties: false,
} as const

const stateSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    goal: goalSchema,
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const

export interface GoalStatus {
  sessionID: string
  goal?: {
    id: string
    objective: string
    status: string
    tokensUsed: number
    tokenBudget?: number
    timeUsedSeconds: number
  }
}

export const GoalRpc = Rpc.define({
  id: "gery.goal",
  methods: {
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: stateSchema,
    },
  },
  events: {
    changed: { schema: stateSchema },
  },
})
