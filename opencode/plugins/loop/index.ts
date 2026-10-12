/**
 * loop — timers for OpenCode, ported from pi's /loop extension.
 *
 * Commands:
 *   /loop 5m check CI and fix anything red     fixed interval
 *   /loop check the workers and sweep them      dynamic: the agent picks each delay
 *   /loop status
 *   /loop stop
 *
 * Tools the agent can call:
 *   schedule_wakeup(delay_s | at, prompt, reason)  one-shot: re-enter later
 *   loop_start(interval, prompt) / loop_stop()     fixed-interval loop
 *
 * The plugin owns one interval timer, one wake-up timer, and one event listener.
 * OpenCode clears all three when it unloads the plugin. A timer lives in the
 * background service, so it survives a TUI restart and is lost on a service restart.
 */

import { Plugin } from "@opencode/plugin"
import { LoopRpc, type LoopStatus } from "./rpc"

type SessionID = string

interface Loop {
  prompt: string
  label: string
  runs: number
  sessionID: SessionID
  timer: ReturnType<typeof setInterval>
}

interface Wakeup {
  at: number
  prompt: string
  reason: string
  sessionID: SessionID
  timer: ReturnType<typeof setTimeout>
}

const MIN_INTERVAL_MS = 5_000
const MIN_DELAY_S = 30
const MAX_DELAY_S = 86_400

/** Parse "30s", "5m", "1h", or a bare number of seconds. Return milliseconds, or null when the value is too small. */
function parseInterval(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(raw.trim())
  if (!match) return null
  const value = Number(match[1])
  const unit = (match[2] ?? "s").toLowerCase()
  const scale = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000
  const ms = Math.round(value * scale)
  return ms >= MIN_INTERVAL_MS ? ms : null
}

function formatDelay(seconds: number): string {
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)}h`
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds)}s`
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/** The prompt that makes the agent pace its own loop, like pi's dynamic /loop. */
function dynamicPrompt(task: string): string {
  return (
    `/loop (dynamic, self-paced) — task:\n${task}\n\n` +
    `You are in a self-paced loop. Do one pass of the task now. Then, at the END of this and every later turn, call ` +
    `schedule_wakeup(delay_s, prompt, reason) with this exact task text as the prompt and a delay you choose from what ` +
    `you are actually waiting for (30s–24h, or a fixed time via at). Not calling schedule_wakeup ends the loop — do that ` +
    `only when the task is complete, and say so; the user can also end it with /loop stop.`
  )
}

export default Plugin.define({
  id: "loop",

  async setup(ctx) {
    let loop: Loop | undefined
    let wakeup: Wakeup | undefined
    // Last known busy state per session. A timer steers an idle session and
    // queues behind a running turn, like pi's ctx.isIdle().
    const busy = new Map<SessionID, boolean>()

    // Filled in after the RPC registers below; a safe no-op until then.
    let announce: (sessionID: SessionID) => void = () => {}

    const snapshot = (sessionID: SessionID): LoopStatus => ({
      sessionID,
      ...(loop && loop.sessionID === sessionID
        ? { loop: { label: loop.label, prompt: loop.prompt, runs: loop.runs, sessionID: loop.sessionID } }
        : {}),
      ...(wakeup && wakeup.sessionID === sessionID
        ? { wakeup: { at: wakeup.at, prompt: wakeup.prompt, reason: wakeup.reason, sessionID: wakeup.sessionID } }
        : {}),
    })

    const isBusy = (sessionID: SessionID): boolean => busy.get(sessionID) ?? false

    const deliver = (sessionID: SessionID, text: string): void => {
      void ctx.session
        .prompt({ sessionID, text, delivery: isBusy(sessionID) ? "queue" : "steer" })
        .catch((error: unknown) => console.error(`loop: delivery to ${sessionID} failed:`, error))
    }

    // A synthetic message shows status without starting a model turn.
    const note = (sessionID: SessionID, text: string): void => {
      void ctx.session.synthetic({ sessionID, text }).catch(() => {})
    }

    const stopLoop = (): boolean => {
      if (!loop) return false
      const sessionID = loop.sessionID
      clearInterval(loop.timer)
      loop = undefined
      announce(sessionID)
      return true
    }

    const clearWakeup = (): boolean => {
      if (!wakeup) return false
      const sessionID = wakeup.sessionID
      clearTimeout(wakeup.timer)
      wakeup = undefined
      announce(sessionID)
      return true
    }

    /** One pass of the loop: count it, then re-enter the session with the prompt. */
    const fire = (): void => {
      if (!loop) return
      loop.runs += 1
      announce(loop.sessionID)
      deliver(loop.sessionID, loop.prompt)
    }

    const startLoop = (sessionID: SessionID, ms: number, label: string, prompt: string): void => {
      stopLoop()
      loop = { prompt, label, runs: 0, sessionID, timer: setInterval(fire, ms) }
      fire()
    }

    // ── tools (agent-driven) ────────────────────────────────────────────

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "schedule_wakeup",
        description:
          "Re-enter this session after a delay with the given prompt, like Claude Code's ScheduleWakeup. One-shot: " +
          "each firing must call schedule_wakeup again to continue the loop, or stop by not calling it (or stop: true). " +
          "Use it to self-pace a monitoring loop (\"sweep the workers\", \"check CI\") instead of sleeping or polling. " +
          "Delay is clamped to 30s–24h; pass at (\"HH:MM\" local or ISO-8601) instead of delay_s for a fixed clock time. " +
          "Only one pending wake-up exists at a time; a new call replaces it.",
        input: {
          type: "object",
          properties: {
            delay_s: { type: "number", description: "Seconds until the wake-up (30–86400). Required unless at or stop is given." },
            at: { type: "string", description: "Wake at a clock time instead: \"HH:MM\" (local, next occurrence) or an ISO-8601 timestamp. Overrides delay_s." },
            prompt: { type: "string", description: "The prompt to re-enter with. Pass the same loop instruction each time. Required unless stop is true." },
            reason: { type: "string", description: "One short sentence on what you are waiting for (shown to the user)." },
            stop: { type: "boolean", description: "true cancels the pending wake-up and ends the loop." },
          },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const params = (input ?? {}) as { delay_s?: number; at?: string; prompt?: string; reason?: string; stop?: boolean }
          const sessionID = context.sessionID

          if (params.stop) {
            return { content: clearWakeup() ? "wake-up cancelled; loop ended" : "no wake-up was pending" }
          }

          let delayS = params.delay_s
          if (params.at) {
            const hhmm = /^(\d{1,2}):(\d{2})$/.exec(params.at.trim())
            let target: number
            if (hhmm) {
              const date = new Date()
              date.setHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0)
              if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1) // already past today → tomorrow
              target = date.getTime()
            } else {
              target = Date.parse(params.at)
              if (Number.isNaN(target)) {
                return { content: `cannot parse at="${params.at}" — use "HH:MM" or ISO-8601` }
              }
            }
            delayS = (target - Date.now()) / 1_000
          }

          if (!params.prompt || delayS == null) {
            return { content: "prompt and delay_s (or at) are required (or stop: true)" }
          }

          const delay = Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(delayS)))
          const prompt = params.prompt
          const reason = params.reason ?? ""
          clearWakeup()
          const at = Date.now() + delay * 1_000
          wakeup = {
            at,
            prompt,
            reason,
            sessionID,
            timer: setTimeout(() => {
              wakeup = undefined
              deliver(sessionID, `[wake-up${reason ? ` — ${reason}` : ""}]\n${prompt}`)
            }, delay * 1_000),
          }
          announce(sessionID)
          return {
            content:
              `wake-up scheduled in ${formatDelay(delay)} (${new Date(at).toLocaleString()}). ` +
              `Nothing more to do now — end your turn; you are re-invoked with the prompt.`,
          }
        },
      })

      editor.add({
        name: "loop_start",
        description:
          "Start a fixed-interval loop: re-enter this session with `prompt` every `interval` (e.g. 5m, 30s, 1h; min 5s). " +
          "Same as the /loop command. Replaces any running loop.",
        input: {
          type: "object",
          properties: {
            interval: { type: "string", description: "e.g. 30s, 5m, 1h" },
            prompt: { type: "string", description: "The prompt to re-enter with every interval." },
          },
          required: ["interval", "prompt"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const params = input as { interval: string; prompt: string }
          const ms = parseInterval(params.interval)
          if (ms === null) return { content: "bad interval (min 5s): use 30s, 5m, 1h" }
          startLoop(context.sessionID, ms, params.interval, params.prompt)
          return { content: `loop started: every ${params.interval}. The first run fires now; end your turn.` }
        },
      })

      editor.add({
        name: "loop_stop",
        description: "Stop the running /loop and any pending wake-up.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const had = stopLoop()
          const hadWakeup = clearWakeup()
          return { content: had || hadWakeup ? "loop stopped" : "no loop or wake-up was running" }
        },
      })
    })

    // ── command (/loop) ─────────────────────────────────────────────────

    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: "loop",
        description: "Run a prompt every interval: /loop 5m <prompt> | /loop status | /loop stop",
        execute: async ({ sessionID, prompt }) => {
          const trimmed = prompt.text.trim()

          if (!trimmed || trimmed === "status") {
            if (loop) note(sessionID, `loop: every ${loop.label}, ${loop.runs} run(s) so far — "${loop.prompt}"`)
            else if (wakeup) note(sessionID, `no loop; wake-up at ${formatClock(wakeup.at)}${wakeup.reason ? ` (${wakeup.reason})` : ""}`)
            else note(sessionID, "no loop or wake-up running")
            return
          }

          if (trimmed === "stop") {
            const had = stopLoop() || clearWakeup()
            note(sessionID, had ? "loop stopped" : "no loop or wake-up running")
            return
          }

          const [intervalRaw, ...rest] = trimmed.split(/\s+/)
          const ms = parseInterval(intervalRaw)
          if (ms === null) {
            // Dynamic mode: the agent paces itself by calling schedule_wakeup each turn.
            stopLoop()
            clearWakeup()
            note(sessionID, "dynamic loop: the agent schedules each next run itself — /loop stop to end")
            deliver(sessionID, dynamicPrompt(trimmed))
            return
          }

          const task = rest.join(" ").trim()
          if (!task) {
            note(sessionID, "Usage: /loop [interval e.g. 5m|30s|1h] <prompt>")
            return
          }

          note(sessionID, `loop started: every ${intervalRaw} — /loop stop to end`)
          startLoop(sessionID, ms, intervalRaw, task)
        },
      })
    })

    // ── rpc (state for the TUI) ─────────────────────────────────────────

    const rpc = await ctx.rpc.register(LoopRpc, {
      status: async (input) => snapshot((input as { sessionID: string }).sessionID),
    })
    announce = (sessionID) => {
      void rpc.events.emit("changed", snapshot(sessionID)).catch(() => {})
    }

    // ── listener (session busy state) ───────────────────────────────────

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = event.data as { sessionID?: SessionID; status?: { type?: string } } | undefined
          const sessionID = data?.sessionID
          if (!sessionID) continue
          switch (event.type) {
            case "session.execution.started":
              busy.set(sessionID, true)
              break
            case "session.status":
              busy.set(sessionID, data?.status?.type !== "idle")
              break
            case "session.idle":
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
              busy.set(sessionID, false)
              break
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("loop: event listener stopped:", error)
      }
    })()

    return async () => {
      stopLoop()
      clearWakeup()
      controller.abort()
      busy.clear()
      await rpc.dispose()
      await commands.dispose()
      await tools.dispose()
    }
  },
})
