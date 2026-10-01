/**
 * Session-scoped goals for pi, modelled on Codex's per-thread goal.
 *
 * Codex keeps exactly one goal per thread (`thread_goals`, keyed by thread_id),
 * exposes it as `/goal [<objective>|clear|edit|pause|resume]` plus the
 * create_goal / update_goal / get_goal tools, and keeps the thread working while
 * the goal is active. A goal belongs to the session that created it: there is no
 * cross-session pool and no "which goal is this session on?" focus step.
 *
 * This extension reproduces that model on pi's own session storage:
 *
 *   - the goal is a `goal` custom entry on the session branch, so it is
 *     per-session, survives resume, and follows /tree navigation;
 *   - `/goal …` is the user surface, the three tools are the model surface;
 *   - an active goal requests one more turn whenever a run settles, until the
 *     goal is completed, blocked, paused, or out of budget — guarded by a
 *     continuation cap (PI_GOAL_MAX_CONTINUATIONS, 0 = unlimited) so a model
 *     that forgets update_goal cannot burn tokens forever.
 *
 * Replaces pi-goal-x: remove `npm:pi-goal-x` from settings.json `packages`
 * before enabling this file — both extensions register create_goal / get_goal /
 * update_goal, and pi rejects duplicate tool names.
 *
 * `tokensUsed` counts the goal's own turns (input + output + cache write; cache
 * reads are excluded), so the number means "what this goal cost to pursue".
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GOAL_ENTRY = "goal";
const GOAL_CONTEXT = "goal-context";
const GOAL_CONTINUATION = "goal-continuation";
const STATUS_KEY = "goal";
const WIDGET_KEY = "goal";
const MAX_CONTINUATIONS_DEFAULT = 50;

/** active/paused/blocked are set by the model or the user; budget_limited is system-only. */
type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";

interface GoalState {
	/** Short stable id, so the user and the model can both name one goal. */
	id: string;
	objective: string;
	status: GoalStatus;
	/** Optional token budget; undefined means unbudgeted. */
	tokenBudget?: number;
	tokensUsed: number;
	/** Frozen at completion so "what the goal cost" does not keep growing afterwards. */
	finalTokens?: number;
	timeUsedSeconds: number;
	/** Last status change reason reported by the model. */
	lastReasoning?: string;
	createdAt: number;
	updatedAt: number;
}

type GoalEntry = { goal: GoalState | null };

const UNFINISHED: readonly GoalStatus[] = ["active", "paused", "blocked", "budget_limited"];

function isUnfinished(status: GoalStatus): boolean {
	return UNFINISHED.includes(status);
}

function statusLabel(status: GoalStatus): string {
	return status === "budget_limited" ? "budget limited" : status;
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function remainingTokens(goal: GoalState): number | undefined {
	if (goal.tokenBudget === undefined) return undefined;
	return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

function budgetExhausted(goal: GoalState): boolean {
	return goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
}

function reportedTokens(goal: GoalState): number {
	return goal.finalTokens ?? goal.tokensUsed;
}

function usageLine(goal: GoalState): string {
	const budget =
		goal.tokenBudget === undefined
			? `${formatTokens(reportedTokens(goal))} tokens`
			: `${formatTokens(reportedTokens(goal))} / ${formatTokens(goal.tokenBudget)} tokens`;
	return `${budget} · ${formatDuration(goal.timeUsedSeconds)}`;
}

function shortObjective(goal: GoalState, max = 44): string {
	const flat = goal.objective.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Flatten a custom message's content (string or content blocks) so it can be compared by text. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: string }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/** Model-facing goal block, injected before every run (Codex's thread-goal section). */
function goalContextText(goal: GoalState): string {
	const lines = [
		"[SESSION GOAL]",
		`Id: ${goal.id}`,
		`Objective: ${goal.objective}`,
		`Status: ${statusLabel(goal.status)}`,
		goal.tokenBudget === undefined
			? `Tokens: ${formatTokens(reportedTokens(goal))} used, no budget`
			: `Tokens: ${formatTokens(reportedTokens(goal))} used of ${formatTokens(goal.tokenBudget)} (${formatTokens(
					remainingTokens(goal) ?? 0,
				)} remaining)`,
		`Time: ${formatDuration(goal.timeUsedSeconds)}`,
	];
	if (goal.lastReasoning) lines.push(`Last reported: ${goal.lastReasoning}`);
	lines.push("");

	if (goal.status === "active") {
		lines.push(
			"Pursue this objective until it is verifiably complete. Keep working across turns; do not stop to ask whether to continue.",
			'When every requirement is satisfied and no required work remains, call update_goal with status "complete" so the accounting is recorded.',
			"Never mark it complete on intent, partial progress, memory of earlier work, or a plausible-looking answer — only on evidence that each requirement is satisfied.",
			'If the same blocking condition prevents progress for at least three consecutive goal turns, call update_goal with status "blocked" and report the blocker.',
			'Do not call update_goal with "paused" unless the user explicitly asks to pause.',
		);
	} else if (goal.status === "paused") {
		lines.push("This goal is paused at the user's request. Do not work on it; the user resumes it with /goal resume.");
	} else if (goal.status === "blocked") {
		lines.push(
			"This goal is blocked. Do not continue work on it; report the blocker and wait for the user (/goal resume restarts it, /goal clear removes it).",
		);
	} else if (goal.status === "budget_limited") {
		lines.push(
			"This goal has exhausted its token budget, so goal work is stopped. Report status and wait for the user (/goal resume continues it, /goal edit changes the objective).",
		);
	} else {
		lines.push("This goal is complete. Do not continue work on it; the user can /goal clear to remove it.");
	}
	return lines.join("\n");
}

/** Model-facing text for one automatic continuation (Codex's "Continue working toward the active thread goal."). */
function continuationText(goal: GoalState): string {
	return [
		"Continue working toward the active thread goal.",
		"",
		goalContextText(goal),
		"",
		"Pick up the next unfinished step now. Do not re-summarize progress you already reported and do not ask for permission to continue.",
	].join("\n");
}

export default function goalExtension(pi: ExtensionAPI): void {
	let goal: GoalState | undefined;
	let initialized = false;
	let turnStartedAt: number | undefined;
	/** Automatic continuations since the user last spoke. */
	let continuations = 0;
	let capWarned = false;
	/**
	 * Goal text that must stay in context for the request being built, and nothing else: either the
	 * block this run injected (`before_agent_start`) or the reminder the current continuation
	 * committed. pi adds the run's injection after the `context` handler has run, so the handler
	 * cannot count them — it drops every copy that is not the current one, by content.
	 */
	let liveGoalText: string | undefined;

	function maxContinuations(): number {
		const raw = process.env.PI_GOAL_MAX_CONTINUATIONS;
		if (raw === undefined || raw.trim() === "") return MAX_CONTINUATIONS_DEFAULT;
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : MAX_CONTINUATIONS_DEFAULT;
	}

	function persist(): void {
		pi.appendEntry<GoalEntry>(GOAL_ENTRY, { goal: goal ?? null });
	}

	/** The last `goal` entry on the current branch wins (branch navigation is a real history). */
	function restore(ctx: ExtensionContext): void {
		let restored: GoalState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;
			const data = entry.data as GoalEntry | undefined;
			restored = data?.goal ?? undefined;
		}
		goal = restored;
		initialized = true;
	}

	function ensureInit(ctx: ExtensionContext): void {
		if (!initialized) restore(ctx);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (!goal) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const color: "accent" | "success" | "warning" | "muted" =
			goal.status === "active"
				? "accent"
				: goal.status === "complete"
					? "success"
					: goal.status === "paused"
						? "muted"
						: "warning";
		const budget =
			goal.tokenBudget === undefined
				? formatTokens(reportedTokens(goal))
				: `${formatTokens(reportedTokens(goal))}/${formatTokens(goal.tokenBudget)}`;
		ctx.ui.setStatus(
			STATUS_KEY,
			theme.fg(color, `🎯 ${shortObjective(goal, 32)} · ${statusLabel(goal.status)} · ${budget}`),
		);
		ctx.ui.setWidget(WIDGET_KEY, [
			`${theme.fg("muted", "goal")} ${theme.fg(color, statusLabel(goal.status))} ${theme.fg("dim", goal.id)}`,
			` ${goal.objective.split("\n")[0]}`,
			` ${theme.fg("muted", usageLine(goal))}`,
		]);
	}

	function setGoal(objective: string, ctx: ExtensionContext): void {
		const now = Date.now();
		goal = {
			id: `g_${now.toString(36)}`,
			objective,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		};
		continuations = 0;
		capWarned = false;
		persist();
		updateUi(ctx);
	}

	function statusReport(state: GoalState): string {
		const lines = [
			`Goal ${state.id} — ${statusLabel(state.status)}`,
			state.objective,
			"",
			usageLine(state),
		];
		if (state.lastReasoning) lines.push(`Reported: ${state.lastReasoning}`);
		lines.push("", "Pursue it while it is active; /goal pause, /goal resume, /goal edit, /goal clear.");
		return lines.join("\n");
	}

	// ── User surface: /goal [<objective>|clear|edit|pause|resume] ─────────────

	pi.registerCommand("goal", {
		description: "Set, show, edit, pause, resume or clear this session's goal",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ensureInit(ctx);
			const raw = args.trim();
			const sub = (raw.split(/\s+/)[0] ?? "").toLowerCase();

			if (raw === "") {
				ctx.ui.notify(goal ? statusReport(goal) : "No goal is currently set for this session.", "info");
				return;
			}

			if (sub === "clear") {
				if (!goal) {
					ctx.ui.notify("No goal to clear.", "info");
					return;
				}
				goal = undefined;
				continuations = 0;
				capWarned = false;
				liveGoalText = undefined;
				persist();
				updateUi(ctx);
				ctx.ui.notify("Goal cleared.", "info");
				return;
			}

			if (sub === "pause") {
				if (!goal) {
					ctx.ui.notify("No goal is currently set.", "info");
					return;
				}
				if (goal.status === "complete") {
					ctx.ui.notify("This goal is already complete.", "info");
					return;
				}
				goal.status = "paused";
				goal.updatedAt = Date.now();
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Goal paused. /goal resume continues it.`, "info");
				return;
			}

			if (sub === "resume") {
				if (!goal) {
					ctx.ui.notify("No goal is currently set.", "info");
					return;
				}
				if (goal.status === "active") {
					ctx.ui.notify("This goal is already active.", "info");
					return;
				}
				if (budgetExhausted(goal)) {
					ctx.ui.notify(
						`Goal budget is exhausted (${formatTokens(goal.tokensUsed)} of ${formatTokens(goal.tokenBudget ?? 0)}). /goal edit <objective> starts a fresh goal with new accounting.`,
						"warning",
					);
					return;
				}
				goal.status = "active";
				goal.updatedAt = Date.now();
				continuations = 0;
				capWarned = false;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Goal resumed.`, "info");
				pi.sendUserMessage("Continue working toward the active thread goal.", { deliverAs: "followUp" });
				return;
			}

			if (sub === "edit") {
				if (!goal) {
					ctx.ui.notify("No goal is currently set. Use /goal <objective> to set one.", "info");
					return;
				}
				const edited = await ctx.ui.editor("Edit goal objective", goal.objective);
				if (edited === undefined || edited.trim() === "") return;
				goal.objective = edited.trim();
				goal.updatedAt = Date.now();
				persist();
				updateUi(ctx);
				ctx.ui.notify("Goal objective updated.", "info");
				return;
			}

			// Anything else is the objective itself.
			const replacing = goal !== undefined && isUnfinished(goal.status);
			setGoal(raw, ctx);
			ctx.ui.notify(
				replacing
					? "Goal replaced; the previous goal's accounting was reset."
					: "Goal set.",
				"info",
			);
			pi.sendUserMessage(raw, { deliverAs: "followUp" });
		},
	});

	// ── Model surface: create_goal / update_goal / get_goal ──────────────────

	pi.registerTool({
		name: "get_goal",
		label: "Get goal",
		description:
			"Get this session's goal, including status, token budget, tokens used, elapsed goal time and remaining budget. " +
			"Returns that no goal is set when the session has none. Goals belong to the session that created them.",
		promptSnippet: "get_goal: read this session's goal, status, budget and usage",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) => {
			ensureInit(ctx);
			if (!goal) {
				return {
					content: [{ type: "text", text: "This session does not currently have a goal." }],
					details: undefined,
				};
			}
			const text = [
				`Goal ${goal.id}`,
				`Objective: ${goal.objective}`,
				`Status: ${statusLabel(goal.status)}`,
				`Tokens used: ${reportedTokens(goal)}`,
				goal.tokenBudget === undefined
					? "Token budget: none"
					: `Token budget: ${goal.tokenBudget} (${formatTokens(remainingTokens(goal) ?? 0)} remaining)`,
				`Goal time: ${formatDuration(goal.timeUsedSeconds)}`,
				`Created: ${new Date(goal.createdAt).toISOString()}`,
				`Updated: ${new Date(goal.updatedAt).toISOString()}`,
				...(goal.lastReasoning ? [`Last reported: ${goal.lastReasoning}`] : []),
			].join("\n");
			return { content: [{ type: "text", text }], details: { ...goal } };
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create goal",
		description:
			"Create this session's goal and start pursuing it. Only call this when the user explicitly asks for a goal. " +
			"Starts a new active goal when the session has none, or replaces one that is already complete; a session can only " +
			"have one goal, so an unfinished goal must be finished or cleared by the user first.",
		promptSnippet: "create_goal: start a session goal when the user explicitly asks for one",
		promptGuidelines: [
			"Never infer persistent goals, budgets or completion criteria from an ordinary task; create a goal only when the user explicitly asks for one.",
			"The objective must faithfully preserve every user requirement and ordered step, including verification criteria for multi-step goals.",
			"Pass token_budget only when the user explicitly requested a token budget; omit it otherwise.",
		],
		parameters: Type.Object(
			{
				objective: Type.String({ description: "The concrete objective to start pursuing." }),
				token_budget: Type.Optional(
					Type.Number({ description: "Positive token budget for the new goal. Omit unless explicitly requested." }),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (
			_toolCallId: string,
			params: { objective: string; token_budget?: number },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) => {
			ensureInit(ctx);
			const objective = params.objective?.trim();
			if (!objective) {
				return {
					content: [{ type: "text", text: "create_goal requires a non-empty objective." }],
					details: undefined,
				};
			}
			if (goal && isUnfinished(goal.status)) {
				return {
					content: [
						{
							type: "text",
							text: `This session already has an unfinished goal (${goal.id}, ${statusLabel(goal.status)}): ${goal.objective}\nFinish it (update_goal), or ask the user to /goal clear or /goal edit it before creating another.`,
						},
					],
					details: { ...goal },
				};
			}
			if (params.token_budget !== undefined && (!Number.isFinite(params.token_budget) || params.token_budget <= 0)) {
				return {
					content: [{ type: "text", text: "token_budget must be a positive number of tokens." }],
					details: undefined,
				};
			}

			const now = Date.now();
			goal = {
				id: `g_${now.toString(36)}`,
				objective,
				status: "active",
				tokenBudget: params.token_budget,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			};
			continuations = 0;
			capWarned = false;
			persist();
			updateUi(ctx);

			const budgetLine =
				params.token_budget === undefined ? "Token budget: none." : `Token budget: ${params.token_budget} tokens.`;
			return {
				content: [
					{
						type: "text",
						text: `Goal ${goal.id} created and active.\nObjective: ${objective}\n${budgetLine}\nKeep working until evidence proves every requirement is satisfied, then call update_goal with status "complete".`,
					},
				],
				details: { ...goal },
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update goal",
		description:
			"Report this session's goal as complete, blocked, or paused at the user's explicit request. Completion is a claim " +
			"that the whole objective is finished and can withstand requirement-by-requirement scrutiny; when evidence is " +
			"incomplete, weak or leaves a requirement unverified, keep working instead. Resume and budget statuses are " +
			"controlled by the user or the system, not by this tool.",
		promptSnippet: "update_goal: mark the session goal complete, blocked, or paused",
		promptGuidelines: [
			'Do not call update_goal unless the goal is actually complete or the user explicitly requests a pause; never pause on your own initiative.',
			'Do not call update_goal with status "blocked" the first time a blocker appears; report the blocker and keep working. After the same blocking condition repeats across at least three consecutive goal turns, mark it blocked.',
			'Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active — call update_goal with status "blocked".',
			'When a goal with a token budget is complete, report the final consumed token budget from the tool result to the user.',
		],
		parameters: Type.Object(
			{
				status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("paused")], {
					description: 'New status: "complete", "blocked", or "paused" (pause only when the user asked).',
				}),
				reasoning: Type.Optional(
					Type.String({ description: "Short evidence or blocker report recorded with the status change." }),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (
			_toolCallId: string,
			params: { status: "complete" | "blocked" | "paused"; reasoning?: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) => {
			ensureInit(ctx);
			if (!goal) {
				return {
					content: [{ type: "text", text: "Cannot update the goal because this session has no goal." }],
					details: undefined,
				};
			}
			if (goal.status === "complete") {
				return {
					content: [
						{
							type: "text",
							text: `Goal ${goal.id} is already complete (${reportedTokens(goal)} tokens, ${formatDuration(goal.timeUsedSeconds)}). The user can /goal clear or /goal edit to start a new one.`,
						},
					],
					details: { ...goal },
				};
			}
			if (goal.status === "budget_limited") {
				return {
					content: [
						{
							type: "text",
							text: `Goal ${goal.id} is budget limited — the user's token budget was exhausted, and that status takes precedence over "${params.status}". Report the state and wait for the user.`,
						},
					],
					details: { ...goal },
				};
			}

			goal.status = params.status;
			goal.lastReasoning = params.reasoning?.trim() || undefined;
			goal.updatedAt = Date.now();
			persist();
			updateUi(ctx);

			const usage = `${reportedTokens(goal)} tokens used${goal.tokenBudget === undefined ? "" : ` of ${goal.tokenBudget}`} over ${formatDuration(goal.timeUsedSeconds)}`;
			const text =
				params.status === "complete"
					? `Goal ${goal.id} marked complete. ${usage}.`
					: params.status === "blocked"
						? `Goal ${goal.id} marked blocked: ${goal.lastReasoning ?? "no reason given"}. ${usage}.`
						: `Goal ${goal.id} marked paused at the user's request. ${usage}.`;
			return { content: [{ type: "text", text }], details: { ...goal } };
		},
	});

	// ── Lifecycle ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		turnStartedAt = undefined;
		continuations = 0;
		capWarned = false;
		liveGoalText = undefined;
		updateUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	// A real user turn resets the automatic-continuation allowance.
	pi.on("input", async (event) => {
		if (event.source === "extension") return;
		continuations = 0;
		capWarned = false;
	});

	pi.on("turn_start", async () => {
		turnStartedAt = Date.now();
	});

	// Usage accounting rides on message_end, not turn_end: turn_end is a boundary event that pi
	// rejects when it cannot resolve the assistant entry, and accounting does not need a boundary.
	pi.on("message_end", async (event, ctx) => {
		ensureInit(ctx);
		const message = event.message as {
			role?: string;
			usage?: { input?: number; output?: number; cacheWrite?: number };
		};
		if (message.role !== "assistant") return;

		if (turnStartedAt !== undefined) {
			const seconds = Math.max(0, Math.round((Date.now() - turnStartedAt) / 1000));
			if (goal) goal.timeUsedSeconds += seconds;
			turnStartedAt = undefined;
		}
		if (!goal) return;

		const wasActive = goal.status === "active" || goal.status === "budget_limited";
		const completingTurn = goal.status === "complete" && goal.finalTokens === undefined;
		if (message.usage && (wasActive || completingTurn)) {
			const { input = 0, output = 0, cacheWrite = 0 } = message.usage;
			goal.tokensUsed += input + output + cacheWrite;
			goal.updatedAt = Date.now();
			if (completingTurn) goal.finalTokens = goal.tokensUsed;
		}

		if (wasActive && goal.status === "active" && budgetExhausted(goal)) {
			goal.status = "budget_limited";
			goal.updatedAt = Date.now();
			ctx.ui.notify(
				`Goal ${goal.id} hit its token budget (${formatTokens(goal.tokensUsed)} of ${formatTokens(goal.tokenBudget ?? 0)}); goal work stopped. /goal clear or /goal edit to start another.`,
				"warning",
			);
		}

		persist();
		updateUi(ctx);
	});

	// Keep exactly one goal block in context. Both the run injection and the continuation reminder
	// are persisted in the transcript, so without this they would stack up one copy per run/turn.
	pi.on("context", async (event) => {
		const filtered = event.messages.filter((message) => {
			const custom = message as { customType?: string; content?: unknown };
			if (custom.customType !== GOAL_CONTEXT && custom.customType !== GOAL_CONTINUATION) return true;
			return liveGoalText !== undefined && messageText(custom.content) === liveGoalText;
		});
		return filtered.length === event.messages.length ? undefined : { messages: filtered };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		ensureInit(ctx);
		// A new user-prompted run replaces any continuation reminder still in the transcript.
		if (!goal) {
			liveGoalText = undefined;
			return;
		}
		liveGoalText = goalContextText(goal);
		return {
			message: { customType: GOAL_CONTEXT, content: liveGoalText, display: false },
		};
	});

	// Codex-style continuation: while the goal is active, one more turn per settled run.
	// pi re-checks whether the run is continuable after committing the reminder entry below
	// (`agent_before_settle`), so the entry is what makes the continuation runnable — checking
	// `event.context.canContinue` here would always be false and silently disable continuation.
	pi.on("agent_before_settle", async (event, ctx) => {
		ensureInit(ctx);
		if (!goal || goal.status !== "active") return;
		if (event.outcome !== "completed") return;

		const cap = maxContinuations();
		if (cap > 0 && continuations >= cap) {
			if (!capWarned) {
				capWarned = true;
				ctx.ui.notify(
					`Goal ${goal.id}: stopped after ${cap} automatic turns without user input. Send any message to continue, or /goal clear.`,
					"warning",
				);
			}
			return;
		}

		continuations += 1;
		// The reminder carries the full, current goal block, so it replaces the run's injection.
		liveGoalText = continuationText(goal);
		return {
			entries: [
				{ type: "custom_message", customType: GOAL_CONTINUATION, content: liveGoalText, display: false },
			],
			continue: true,
		};
	});
}
