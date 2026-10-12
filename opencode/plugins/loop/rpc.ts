import { Rpc } from "@opencode/plugin/rpc"

/**
 * State the loop plugin shares with its TUI entry.
 *
 * The server plugin owns the timers; the TUI runs in a separate process, so it
 * reads this state over RPC and follows `changed` events.
 */

const loopSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    prompt: { type: "string" },
    runs: { type: "number" },
    sessionID: { type: "string" },
  },
  required: ["label", "prompt", "runs", "sessionID"],
  additionalProperties: false,
} as const

const wakeupSchema = {
  type: "object",
  properties: {
    at: { type: "number" },
    prompt: { type: "string" },
    reason: { type: "string" },
    sessionID: { type: "string" },
  },
  required: ["at", "prompt", "reason", "sessionID"],
  additionalProperties: false,
} as const

const stateSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    loop: loopSchema,
    wakeup: wakeupSchema,
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const

export interface LoopStatus {
  sessionID: string
  loop?: { label: string; prompt: string; runs: number; sessionID: string }
  wakeup?: { at: number; prompt: string; reason: string; sessionID: string }
}

export const LoopRpc = Rpc.define({
  id: "gery.loop",
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
