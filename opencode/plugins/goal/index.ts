/**
 * goal — session-scoped goals for OpenCode, ported from pi's /goal extension.
 *
 *   /goal <objective>     set this session's goal (replaces an unfinished one)
 *   /goal                 show it
 *   /goal edit <text>     replace the objective, keep the accounting
 *   /goal pause|resume    pause or resume it
 *   /goal clear           remove it
 *
 * Tools the agent can call:
 *   create_goal(objective, token_budget?)  start a goal when the user asks for one
 *   update_goal(status, reasoning?)        complete, block, pause, or resume a blocked goal
 *   get_goal()                             read status, budget, usage
 *
 * One goal belongs to the session that created it. The goal block is injected
 * into every model call through the `context` hook, so it never stacks in the
 * transcript. Usage comes from the session's own cumulative token counters.
 *
 * pi drives one more turn whenever a run settles. OpenCode has no settle hook,
 * so this plugin requests the continuation from the `session.execution.succeeded`
 * event, guarded by a continuation cap. The cap is OPENCODE_GOAL_MAX_CONTINUATIONS
 * (or PI_GOAL_MAX_CONTINUATIONS); 0 means unlimited. Default 50.
 *
 * OpenCode loads one plugin instance per location and may keep an earlier instance
 * alive after a reload. Every instance subscribes to the same event stream, so a
 * goal held in instance memory diverges: an update_goal handled by one instance
 * left the others on their stale "active" copy, and each stale instance requested
 * its own continuation. A blocked goal therefore kept looping.
 *
 * All goal state lives in one process-wide registry on `globalThis`, so every
 * instance reads and writes the same objects. Settle events are keyed by their
 * event id, so only the first instance to see one continues the goal.
 */

import { Plugin } from "@opencode/plugin"
import { GoalRpc, type GoalStatus as GoalSnapshot } from "./rpc"

type SessionID = string

/** active/paused/blocked are set by the model or the user; budget_limited is system-only. */
type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete"

interface GoalState {
  id: string
  objective: string
  status: GoalStatus
  tokenBudget?: number
  /** Cumulative session tokens when the goal was created; usage is measured from here. */
  tokensBase: number
  /** Goal-turn time accumulated while a goal existed. */
  timeUsedMs: number
  lastReasoning?: string
  createdAt: number
  updatedAt: number
}

const MAX_CONTINUATIONS_DEFAULT = 50
const UNFINISHED: readonly GoalStatus[] = ["active", "paused", "blocked", "budget_limited"]
/** Handled settle events kept for duplicate suppression; older entries are dropped first. */
const HANDLED_LIMIT = 256

/**
 * Goal state shared by every instance of this plugin in the OpenCode process.
 * Instances share one event stream and one storage namespace, so they must share
 * one copy of the state or they diverge (see the file header).
 */
interface GoalRegistry {
  goals: Map<SessionID, GoalState>
  loaded: Map<SessionID, Promise<void>>
  /** Automatic continuations since the user last spoke. */
  continuations: Map<SessionID, number>
  capWarned: Map<SessionID, boolean>
  /** Turn start time per session, for goal time accounting. */
  turnStart: Map<SessionID, number>
  /** Last computed usage per session, so a sync announcement can show it. */
  usedCache: Map<SessionID, number>
  /** Settle event id -> seen time, so a second instance cannot recount or re-continue one run. */
  handled: Map<string, number>
}

type GoalRegistryHolder = typeof globalThis & { __opencodeGoalRegistry?: GoalRegistry }

function goalRegistry(): GoalRegistry {
  const holder = globalThis as GoalRegistryHolder
  let registry = holder.__opencodeGoalRegistry
  if (!registry) {
    registry = {
      goals: new Map(),
      loaded: new Map(),
      continuations: new Map(),
      capWarned: new Map(),
      turnStart: new Map(),
      usedCache: new Map(),
      handled: new Map(),
    }
    holder.__opencodeGoalRegistry = registry
  }
  return registry
}

const isUnfinished = (status: GoalStatus): boolean => UNFINISHED.includes(status)
const statusLabel = (status: GoalStatus): string => (status === "budget_limited" ? "budget limited" : status)

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Goal tokens count input + output + cache write; cache reads are excluded. */
function sessionTokens(info: { tokens?: { input?: number; output?: number; cache?: { write?: number } } }): number {
  return (info.tokens?.input ?? 0) + (info.tokens?.output ?? 0) + (info.tokens?.cache?.write ?? 0)
}

function shortObjective(goal: GoalState, max = 44): string {
  const flat = goal.objective.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function usageLine(goal: GoalState, used: number): string {
  const budget = goal.tokenBudget === undefined ? `${formatTokens(used)} tokens` : `${formatTokens(used)} / ${formatTokens(goal.tokenBudget)} tokens`
  return `${budget} · ${formatDuration(Math.round(goal.timeUsedMs / 1000))}`
}

/** Model-facing goal block, injected before every model call (Codex's thread-goal section). */
function goalContextText(goal: GoalState, used: number): string {
  const remaining = goal.tokenBudget === undefined ? 0 : Math.max(0, goal.tokenBudget - used)
  const lines = [
    "[SESSION GOAL]",
    `Id: ${goal.id}`,
    `Objective: ${goal.objective}`,
    `Status: ${statusLabel(goal.status)}`,
    goal.tokenBudget === undefined
      ? `Tokens: ${formatTokens(used)} used, no budget`
      : `Tokens: ${formatTokens(used)} used of ${formatTokens(goal.tokenBudget)} (${formatTokens(remaining)} remaining)`,
    `Time: ${formatDuration(Math.round(goal.timeUsedMs / 1000))}`,
  ]
  if (goal.lastReasoning) lines.push(`Last reported: ${goal.lastReasoning}`)
  lines.push("")

  if (goal.status === "active") {
    lines.push(
      "Pursue this objective until it is verifiably complete. Keep working across turns; do not stop to ask whether to continue.",
      'When every requirement is satisfied and no required work remains, call update_goal with status "complete" so the accounting is recorded.',
      "Never mark it complete on intent, partial progress, memory of earlier work, or a plausible-looking answer — only on evidence that each requirement is satisfied.",
      'If the same blocking condition prevents progress for at least three consecutive goal turns, call update_goal with status "blocked" and report the blocker.',
      'Do not call update_goal with "paused" unless the user explicitly asks to pause.',
    )
  } else if (goal.status === "paused") {
    lines.push("This goal is paused at the user's request. Do not work on it; the user resumes it with /goal resume.")
  } else if (goal.status === "blocked") {
    lines.push(
      "This goal is blocked. Check whether the latest user reply or available evidence resolves every reported blocker.",
      'If every blocker is resolved, call update_goal with status "active" and explain the evidence in reasoning. Then continue work immediately.',
      "Do not require /goal resume after the user supplies the missing decision or authorization.",
      "If any blocker remains, keep the goal blocked and report only what is still needed.",
      "Never treat unrelated input as approval. Preserve scope, authorization, pause, and token-budget limits.",
    )
  } else if (goal.status === "budget_limited") {
    lines.push("This goal has exhausted its token budget, so goal work is stopped. Report status and wait for the user (/goal resume continues it, /goal edit changes the objective).")
  } else {
    lines.push("This goal is complete. Do not continue work on it; the user can /goal clear to remove it.")
  }
  return lines.join("\n")
}

function continuationText(goal: GoalState, used: number): string {
  return ["Continue working toward the active thread goal.", "", goalContextText(goal, used), "", "Pick up the next unfinished step now. Do not re-summarize progress you already reported and do not ask for permission to continue."].join("\n")
}

function maxContinuations(): number {
  const raw = process.env.OPENCODE_GOAL_MAX_CONTINUATIONS ?? process.env.PI_GOAL_MAX_CONTINUATIONS
  if (raw === undefined || raw.trim() === "") return MAX_CONTINUATIONS_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MAX_CONTINUATIONS_DEFAULT
}

export default Plugin.define({
  id: "goal",

  async setup(ctx) {
    const registry = goalRegistry()
    const {
      goals,
      loaded,
      continuations,
      capWarned,
      turnStart,
      usedCache,
      handled,
    } = registry

    // Filled in after the RPC registers below; a safe no-op until then.
    let announce: (sessionID: SessionID) => void = () => {}

    const snapshot = (sessionID: SessionID): GoalSnapshot => {
      const goal = goals.get(sessionID)
      if (!goal) return { sessionID }
      return {
        sessionID,
        goal: {
          id: goal.id,
          objective: goal.objective,
          status: goal.status,
          tokensUsed: usedCache.get(sessionID) ?? 0,
          ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
          timeUsedSeconds: Math.round(goal.timeUsedMs / 1000),
        },
      }
    }

    const key = (sessionID: SessionID): string => `goal/${sessionID}`

    async function load(sessionID: SessionID): Promise<void> {
      if (goals.has(sessionID)) return
      let pending = loaded.get(sessionID)
      if (!pending) {
        pending = (async () => {
          const raw = await ctx.storage.get(key(sessionID)).catch(() => undefined)
          if (raw && typeof raw === "object") goals.set(sessionID, raw as GoalState)
        })()
        loaded.set(sessionID, pending)
      }
      await pending
    }

    /**
     * Write the goal, or drop the stored row when the session has none.
     * This must use `remove`: a null value is not stored, so writing `null`
     * left the previous goal in storage and a later load resurrected it.
     */
    function persist(sessionID: SessionID): void {
      const goal = goals.get(sessionID)
      const write = goal === undefined ? ctx.storage.remove(key(sessionID)) : ctx.storage.set(key(sessionID), goal)
      void write.catch(() => {})
    }

    async function currentTokens(sessionID: SessionID): Promise<number> {
      try {
        const info = await ctx.session.get({ sessionID })
        return sessionTokens(info)
      } catch {
        return 0
      }
    }

    async function usedTokens(sessionID: SessionID): Promise<{ goal: GoalState; used: number } | undefined> {
      const goal = goals.get(sessionID)
      if (!goal) return undefined
      const used = Math.max(0, (await currentTokens(sessionID)) - goal.tokensBase)
      usedCache.set(sessionID, used)
      return { goal, used }
    }

    // A synthetic message shows status without starting a model turn.
    const note = (sessionID: SessionID, text: string): void => {
      void ctx.session.synthetic({ sessionID, text }).catch(() => {})
    }

    function statusReport(goal: GoalState, used: number): string {
      const lines = [`Goal ${goal.id} — ${statusLabel(goal.status)}`, goal.objective, "", usageLine(goal, used)]
      if (goal.lastReasoning) lines.push(`Reported: ${goal.lastReasoning}`)
      lines.push("", "Pursue it while it is active; /goal pause, /goal resume, /goal edit, /goal clear.")
      return lines.join("\n")
    }

    async function setGoal(sessionID: SessionID, objective: string, tokenBudget?: number): Promise<GoalState> {
      const now = Date.now()
      const goal: GoalState = {
        id: `g_${now.toString(36)}`,
        objective,
        status: "active",
        tokenBudget,
        tokensBase: await currentTokens(sessionID),
        timeUsedMs: 0,
        createdAt: now,
        updatedAt: now,
      }
      goals.set(sessionID, goal)
      continuations.set(sessionID, 0)
      capWarned.set(sessionID, false)
      usedCache.set(sessionID, 0)
      persist(sessionID)
      announce(sessionID)
      return goal
    }

    // ── tools (agent-driven) ─────────────────────────────────────────────

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "get_goal",
        description:
          "Get this session's goal, including status, token budget, tokens used, elapsed goal time and remaining budget. " +
          "Returns that no goal is set when the session has none. Goals belong to the session that created them.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => {
          await load(context.sessionID)
          const found = await usedTokens(context.sessionID)
          if (!found) return { content: "This session does not currently have a goal." }
          const { goal, used } = found
          const remaining = goal.tokenBudget === undefined ? undefined : Math.max(0, goal.tokenBudget - used)
          const text = [
            `Goal ${goal.id}`,
            `Objective: ${goal.objective}`,
            `Status: ${statusLabel(goal.status)}`,
            `Tokens used: ${used}`,
            goal.tokenBudget === undefined ? "Token budget: none" : `Token budget: ${goal.tokenBudget} (${formatTokens(remaining ?? 0)} remaining)`,
            `Goal time: ${formatDuration(Math.round(goal.timeUsedMs / 1000))}`,
            `Created: ${new Date(goal.createdAt).toISOString()}`,
            `Updated: ${new Date(goal.updatedAt).toISOString()}`,
            ...(goal.lastReasoning ? [`Last reported: ${goal.lastReasoning}`] : []),
          ].join("\n")
          return { content: text, metadata: { ...goal } }
        },
      })

      editor.add({
        name: "create_goal",
        description:
          "Create this session's goal and start pursuing it. Only call this when the user explicitly asks for a goal. " +
          "Starts a new active goal when the session has none, or replaces one that is already complete; a session can only " +
          "have one goal, so an unfinished goal must be finished or cleared by the user first.",
        input: {
          type: "object",
          properties: {
            objective: { type: "string", description: "The concrete objective to start pursuing." },
            token_budget: { type: "number", description: "Positive token budget for the new goal. Omit unless explicitly requested." },
          },
          required: ["objective"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          await load(context.sessionID)
          const params = input as { objective: string; token_budget?: number }
          const objective = params.objective?.trim()
          if (!objective) return { content: "create_goal requires a non-empty objective." }

          const existing = goals.get(context.sessionID)
          if (existing && isUnfinished(existing.status)) {
            return {
              content:
                `This session already has an unfinished goal (${existing.id}, ${statusLabel(existing.status)}): ${existing.objective}\n` +
                `Finish it (update_goal), or ask the user to /goal clear or /goal edit it before creating another.`,
              metadata: { ...existing },
            }
          }
          if (params.token_budget !== undefined && (!Number.isFinite(params.token_budget) || params.token_budget <= 0)) {
            return { content: "token_budget must be a positive number of tokens." }
          }

          const goal = await setGoal(context.sessionID, objective, params.token_budget)
          const budgetLine = params.token_budget === undefined ? "Token budget: none." : `Token budget: ${params.token_budget} tokens.`
          return {
            content: `Goal ${goal.id} created and active.\nObjective: ${objective}\n${budgetLine}\nKeep working until evidence proves every requirement is satisfied, then call update_goal with status "complete".`,
            metadata: { ...goal },
          }
        },
      })

      editor.add({
        name: "update_goal",
        description:
          "Report this session's goal as complete or blocked. Pause only at the user's explicit request. " +
          'Use status "active" to resume a blocked goal only after every blocker is resolved. Include evidence in reasoning. ' +
          "Do not resume paused, complete, or budget-limited goals through this tool. Completion is a claim " +
          "that the whole objective is finished and can withstand requirement-by-requirement scrutiny; when evidence is " +
          "incomplete, weak or leaves a requirement unverified, keep working instead.",
        input: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "complete", "blocked", "paused"], description: 'Use "active" only to resume a blocked goal after every blocker is resolved. Pause only when the user asked.' },
            reasoning: { type: "string", description: "Short evidence or blocker report recorded with the status change." },
          },
          required: ["status"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          await load(context.sessionID)
          const params = input as { status: "active" | "complete" | "blocked" | "paused"; reasoning?: string }
          const sessionID = context.sessionID
          const goal = goals.get(sessionID)
          if (!goal) return { content: "Cannot update the goal because this session has no goal." }
          if (goal.status === "complete") {
            return { content: `Goal ${goal.id} is already complete. The user can /goal clear or /goal edit to start a new one.`, metadata: { ...goal } }
          }
          if (goal.status === "budget_limited") {
            return { content: `Goal ${goal.id} is budget limited — the user's token budget was exhausted, and that status takes precedence over "${params.status}". Report the state and wait for the user.`, metadata: { ...goal } }
          }

          if (params.status === "active") {
            if (goal.status !== "blocked") {
              return { content: `Cannot resume goal ${goal.id} from status "${goal.status}". Only blocked goals support agent resume.`, metadata: { ...goal } }
            }
            if (!params.reasoning?.trim()) {
              return { content: "To resume this blocked goal, supply reasoning that explains how every blocker was resolved.", metadata: { ...goal } }
            }
            const used = (await usedTokens(sessionID))?.used ?? 0
            // Recheck after the asynchronous usage read. A user pause must take precedence.
            if (goals.get(sessionID) !== goal || goal.status !== "blocked") {
              return { content: "The goal changed during the resume check. Read get_goal before another update." }
            }
            if (goal.tokenBudget !== undefined && used >= goal.tokenBudget) {
              return { content: "Cannot resume this goal because its token budget is exhausted. Wait for the user.", metadata: { ...goal } }
            }
            continuations.set(sessionID, 0)
            capWarned.set(sessionID, false)
          }

          goal.status = params.status
          goal.lastReasoning = params.reasoning?.trim() || undefined
          goal.updatedAt = Date.now()
          persist(sessionID)
          announce(sessionID)

          const used = (await usedTokens(sessionID))?.used ?? 0
          const usage = `${used} tokens used${goal.tokenBudget === undefined ? "" : ` of ${goal.tokenBudget}`} over ${formatDuration(Math.round(goal.timeUsedMs / 1000))}`
          const content =
            params.status === "complete"
              ? `Goal ${goal.id} marked complete. ${usage}.`
              : params.status === "blocked"
                ? `Goal ${goal.id} marked blocked: ${goal.lastReasoning ?? "no reason given"}. ${usage}.`
                : params.status === "active"
                  ? `Goal ${goal.id} resumed: ${goal.lastReasoning}. ${usage}. Continue the next unfinished step now.`
                  : `Goal ${goal.id} marked paused at the user's request. ${usage}.`
          return { content, metadata: { ...goal } }
        },
      })
    })

    // ── command (/goal) ──────────────────────────────────────────────────

    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "Set, show, edit, pause, resume or clear this session's goal",
        execute: async ({ sessionID, prompt }) => {
          await load(sessionID)
          const raw = prompt.text.trim()
          const sub = (raw.split(/\s+/)[0] ?? "").toLowerCase()

          if (raw === "") {
            const found = await usedTokens(sessionID)
            note(sessionID, found ? statusReport(found.goal, found.used) : "No goal is currently set for this session.")
            return
          }

          if (sub === "clear") {
            const had = goals.has(sessionID)
            goals.delete(sessionID)
            continuations.set(sessionID, 0)
            capWarned.set(sessionID, false)
            // Always persist: this also removes a stored row left by an older version.
            persist(sessionID)
            announce(sessionID)
            note(sessionID, had ? "Goal cleared." : "No goal to clear.")
            return
          }

          const goal = goals.get(sessionID)

          if (sub === "pause") {
            if (!goal) return note(sessionID, "No goal is currently set.")
            if (goal.status === "complete") return note(sessionID, "This goal is already complete.")
            goal.status = "paused"
            goal.updatedAt = Date.now()
            persist(sessionID)
            announce(sessionID)
            note(sessionID, "Goal paused. /goal resume continues it.")
            return
          }

          if (sub === "resume") {
            if (!goal) return note(sessionID, "No goal is currently set.")
            if (goal.status === "active") return note(sessionID, "This goal is already active.")
            const used = (await usedTokens(sessionID))?.used ?? 0
            if (goal.tokenBudget !== undefined && used >= goal.tokenBudget) {
              note(sessionID, `Goal budget is exhausted (${formatTokens(used)} of ${formatTokens(goal.tokenBudget)}). /goal edit <objective> starts a fresh goal with new accounting.`)
              return
            }
            goal.status = "active"
            goal.updatedAt = Date.now()
            continuations.set(sessionID, 0)
            capWarned.set(sessionID, false)
            persist(sessionID)
            announce(sessionID)
            note(sessionID, "Goal resumed.")
            void ctx.session.prompt({ sessionID, text: "Continue working toward the active thread goal.", delivery: "steer" }).catch(() => {})
            return
          }

          if (sub === "edit") {
            if (!goal) return note(sessionID, "No goal is currently set. Use /goal <objective> to set one.")
            const edited = raw.slice(4).trim()
            if (!edited) return note(sessionID, "Usage: /goal edit <objective>")
            goal.objective = edited
            goal.updatedAt = Date.now()
            persist(sessionID)
            announce(sessionID)
            note(sessionID, "Goal objective updated.")
            return
          }

          // Anything else is the objective itself.
          const replacing = goal !== undefined && isUnfinished(goal.status)
          await setGoal(sessionID, raw)
          note(sessionID, replacing ? "Goal replaced; the previous goal's accounting was reset." : "Goal set.")
          void ctx.session.prompt({ sessionID, text: raw, delivery: "steer" }).catch(() => {})
        },
      })
    })

    // ── context injection ────────────────────────────────────────────────

    const contextHook = await ctx.session.hook("context", async (event) => {
      await load(event.sessionID)
      const goal = goals.get(event.sessionID)
      if (!goal) return
      const used = (await usedTokens(event.sessionID))?.used ?? 0
      event.system.push({ type: "text", text: goalContextText(goal, used) })
    })

    // A real user turn resets the automatic-continuation allowance.
    const promptHook = await ctx.session.hook("prompt", (event) => {
      const meta = event.metadata as { goalContinuation?: boolean } | undefined
      if (meta?.goalContinuation) return
      continuations.set(event.sessionID, 0)
      capWarned.set(event.sessionID, false)
    })

    // ── rpc (state for the TUI) ──────────────────────────────────────────

    const rpc = await ctx.rpc.register(GoalRpc, {
      status: async (input) => {
        const sessionID = (input as { sessionID: string }).sessionID
        await load(sessionID)
        await usedTokens(sessionID)
        return snapshot(sessionID)
      },
    })
    announce = (sessionID) => {
      void rpc.events.emit("changed", snapshot(sessionID)).catch(() => {})
    }

    // ── listener (turn accounting and continuation) ──────────────────────

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = event.data as { sessionID?: SessionID } | undefined
          const sessionID = data?.sessionID
          if (!sessionID) continue

          if (event.type === "session.execution.started") {
            turnStart.set(sessionID, Date.now())
            continue
          }

          const settled =
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"
          if (!settled) continue

          // Each instance holds its own subscription, so the same settle arrives once
          // per live instance. Handle it once, whoever gets there first.
          const eventID = (event as { id?: string }).id
          if (eventID !== undefined) {
            if (handled.has(eventID)) continue
            handled.set(eventID, Date.now())
            if (handled.size > HANDLED_LIMIT) {
              for (const [id, seenAt] of handled) {
                handled.delete(id)
                if (handled.size <= HANDLED_LIMIT) break
              }
            }
          }

          const started = turnStart.get(sessionID)
          turnStart.delete(sessionID)

          await load(sessionID)
          const goal = goals.get(sessionID)
          if (!goal) continue

          if (started !== undefined) {
            goal.timeUsedMs += Math.max(0, Date.now() - started)
            goal.updatedAt = Date.now()
          }

          const used = (await usedTokens(sessionID))?.used ?? 0

          if (goal.status === "active" && goal.tokenBudget !== undefined && used >= goal.tokenBudget) {
            goal.status = "budget_limited"
            goal.updatedAt = Date.now()
            persist(sessionID)
            announce(sessionID)
            note(sessionID, `Goal ${goal.id} hit its token budget (${formatTokens(used)} of ${formatTokens(goal.tokenBudget)}); goal work stopped. /goal clear or /goal edit to start another.`)
            continue
          }

          persist(sessionID)
          announce(sessionID)

          // Codex-style continuation: while the goal is active, request one more turn.
          if (goal.status !== "active" || event.type !== "session.execution.succeeded") continue
          const cap = maxContinuations()
          const count = continuations.get(sessionID) ?? 0
          if (cap > 0 && count >= cap) {
            if (!capWarned.get(sessionID)) {
              capWarned.set(sessionID, true)
              note(sessionID, `Goal ${goal.id}: stopped after ${cap} automatic turns without user input. Send any message to continue, or /goal clear.`)
            }
            continue
          }
          continuations.set(sessionID, count + 1)
          void ctx.session
            .prompt({ sessionID, text: continuationText(goal, used), delivery: "steer", metadata: { goalContinuation: true } })
            .catch(() => {})
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("goal: event listener stopped:", error)
      }
    })()

    return async () => {
      controller.abort()
      // Goal state is shared and durable: a reload must not drop a live goal.
      await rpc.dispose()
      await contextHook.dispose()
      await promptHook.dispose()
      await commands.dispose()
      await tools.dispose()
    }
  },
})
