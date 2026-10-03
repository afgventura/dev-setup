/**
 * Live view of subagent children — what is running, what it is doing, and what
 * finished — replacing the widget/FleetView the in-process engine used to draw.
 *
 * It is deliberately event-driven. The old engine repainted a full frame every
 * 80ms (and its roster every 200ms) whether or not anything had changed, which is
 * 12.5 layout passes a second on the session's only thread — the cost that made
 * long sessions lag. Here a repaint happens when an agent starts, reports tool
 * activity, or finishes; the only timer is a 1s tick that exists *while* agents
 * are running (for the elapsed column) and is cleared the moment none are.
 *
 * The engine notifies the orchestrator; this extension draws the notification box
 * (`registerMessageRenderer`), the widget above the editor, the status line, and
 * `/agents`. Uninstall it and everything still works — the engine is unaffected.
 *
 * Config, from <agent dir>/subagents-local.json (or PI_SUBAGENTS_LOCAL_CONFIG):
 *   { "ui": true, "uiPlacement": "aboveEditor" | "belowEditor", "uiMaxRows": 6 }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "subagents";
const STATUS_KEY = "subagents";
const NOTIFICATION_TYPE = "subagent-notification";
const TICK_MS = 1_000;
const DEFAULT_MAX_ROWS = 6;
const MAX_FINISHED_KEPT = 30;

interface Config {
	ui: boolean;
	placement: "aboveEditor" | "belowEditor";
	maxRows: number;
}

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	return override && override.length > 0
		? override
		: join(homedir(), ".pi", "agent");
}

function loadConfig(): Config {
	const config: Config = {
		ui: true,
		placement: "aboveEditor",
		maxRows: DEFAULT_MAX_ROWS,
	};
	const path =
		process.env.PI_SUBAGENTS_LOCAL_CONFIG &&
		process.env.PI_SUBAGENTS_LOCAL_CONFIG.length > 0
			? process.env.PI_SUBAGENTS_LOCAL_CONFIG
			: join(agentDir(), "subagents-local.json");
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
			string,
			unknown
		>;
		if (typeof raw.ui === "boolean") config.ui = raw.ui;
		if (
			raw.uiPlacement === "aboveEditor" ||
			raw.uiPlacement === "belowEditor"
		) {
			config.placement = raw.uiPlacement;
		}
		if (typeof raw.uiMaxRows === "number" && raw.uiMaxRows > 0) {
			config.maxRows = Math.floor(raw.uiMaxRows);
		}
	} catch {
		// No config: defaults stand.
	}
	return config;
}

interface Tracked {
	id: string;
	type: string;
	/** What this agent is for: the task subject when the caller gave one, else its prompt. */
	label?: string;
	status: "queued" | "running" | "completed" | "failed" | "stopped";
	startedAt: number;
	endedAt?: number;
	toolCalls: number;
	tool?: string;
	/** Tokens and cost for this run, as reported by its own model calls. */
	usage?: AgentUsage;
	transcript?: string;
}

interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function tokensOf(usage: AgentUsage | undefined): number {
	return usage ? usage.input + usage.output : 0;
}

/** 12400 -> "12.4k", so a token count fits a narrow column. */
function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number): string {
	if (usd <= 0) return "$0.00";
	return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function asUsage(value: unknown): AgentUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const num = (key: string): number =>
		typeof record[key] === "number" ? (record[key] as number) : 0;
	return {
		input: num("input"),
		output: num("output"),
		cacheRead: num("cacheRead"),
		cacheWrite: num("cacheWrite"),
		cost: num("cost"),
	};
}

function elapsedSeconds(agent: Tracked): number {
	return ((agent.endedAt ?? Date.now()) - agent.startedAt) / 1000;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	if (!config.ui) return;

	const agents = new Map<string, Tracked>();
	const order: string[] = [];
	let ctx: ExtensionContext | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;
	let sessionName: string | undefined;

	/** Tokens and cost across every run this view has seen. */
	function agentTotals(): { tokens: number; cost: number } {
		let tokens = 0;
		let cost = 0;
		for (const agent of agents.values()) {
			tokens += tokensOf(agent.usage);
			cost += agent.usage?.cost ?? 0;
		}
		return { tokens, cost };
	}

	/**
	 * What the session itself has spent, read from its own entries: pi records a
	 * `usage` on each, priced from the model catalogue. Extensions get no session
	 * total directly, so it is summed here. Children are separate processes and are
	 * not in these entries — that is what `agentTotals` adds on top.
	 */
	function sessionSpend(): { tokens: number; cost: number } {
		try {
			let tokens = 0;
			let cost = 0;
			for (const entry of ctx?.sessionManager.getEntries() ?? []) {
				const usage = (entry as { usage?: Record<string, unknown> }).usage;
				if (!usage) continue;
				const input = typeof usage.input === "number" ? usage.input : 0;
				const output = typeof usage.output === "number" ? usage.output : 0;
				tokens += input + output;
				const entryCost = usage.cost;
				if (typeof entryCost === "number") cost += entryCost;
				else if (entryCost && typeof entryCost === "object") {
					for (const value of Object.values(
						entryCost as Record<string, unknown>,
					)) {
						if (typeof value === "number") cost += value;
					}
				}
			}
			return { tokens, cost };
		} catch {
			return { tokens: 0, cost: 0 };
		}
	}

	/** A one-line label, cut to the room the row has left for it. */
	function labelFor(agent: Tracked, budget: number): string {
		const text = (agent.label ?? agent.type).replace(/\s+/g, " ").trim();
		if (text.length <= budget) return text;
		return `${text.slice(0, Math.max(1, budget - 1))}\u2026`;
	}

	const isActive = (agent: Tracked) =>
		agent.status === "queued" || agent.status === "running";
	const activeAgents = () => [...agents.values()].filter(isActive);

	function track(
		id: string,
		patch: Partial<Tracked> & { type?: string },
	): void {
		const existing = agents.get(id);
		if (existing) {
			Object.assign(existing, patch);
			return;
		}
		agents.set(id, {
			id,
			type: patch.type ?? "agent",
			status: patch.status ?? "running",
			startedAt: patch.startedAt ?? Date.now(),
			toolCalls: patch.toolCalls ?? 0,
			...patch,
		});
		order.push(id);
		while (order.length > MAX_FINISHED_KEPT) {
			const oldest = order.shift();
			if (
				oldest &&
				!isActive(agents.get(oldest) ?? ({ status: "completed" } as Tracked))
			) {
				agents.delete(oldest);
			}
		}
	}

	function render(): void {
		if (!ctx) return;
		const active = activeAgents();
		if (active.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			if (tick) {
				clearInterval(tick);
				tick = undefined;
			}
			return;
		}

		const theme = ctx.ui.theme;
		const queued = active.filter((a) => a.status === "queued").length;
		const running = active.length - queued;
		const summary = [
			running > 0 ? `${running} running` : undefined,
			queued > 0 ? `${queued} queued` : undefined,
		]
			.filter(Boolean)
			.join(", ");
		// Drawn as a component rather than plain strings for two reasons: each line can
		// be cut to the terminal width, and this list gets its own rule with its own
		// title so it cannot read as a continuation of the task list another extension
		// draws directly above it. The label is the task's subject (or its prompt),
		// because four rows all reading "general-purpose" say nothing about what is
		// actually running.
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				invalidate: () => undefined,
				render: (width: number): string[] => {
					const name =
						sessionName && sessionName.length > 40
							? `${sessionName.slice(0, 39)}\u2026`
							: sessionName;
					const totals = agentTotals();
					const combined = totals.cost + sessionSpend().cost;
					const spend = `${totals.tokens > 0 ? ` \u00b7 ${formatTokens(totals.tokens)} tok` : ""} \u00b7 ${formatCost(combined)}`;
					const rule = Math.max(4, width - " agents ".length - 2);
					const lines = [
						`${theme.fg("dim", "\u2500\u2500")}${theme.fg("accent", " agents ")}${theme.fg("dim", "\u2500".repeat(rule))}`,
						truncateToWidth(
							`${theme.fg("accent", "\u2726")}${theme.fg("dim", ` ${summary}${spend}${name ? ` \u00b7 ${name}` : ""}`)}`,
							width,
						),
					];
					const shown = active.slice(-config.maxRows);
					for (const agent of shown) {
						const glyph = agent.status === "queued" ? "\u2026" : "\u25cf";
						const before = `  ${glyph} ${agent.id.slice(0, 8)}  `;
						const after = `  ${elapsedSeconds(agent).toFixed(0)}s  ${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}${agent.tool ? `  ${agent.tool}` : ""}`;
						const budget = Math.max(
							8,
							width - before.length - after.length - 1,
						);
						const tokens = tokensOf(agent.usage);
						lines.push(
							truncateToWidth(
								`${theme.fg("muted", before)}${theme.fg("text", labelFor(agent, budget))}${theme.fg("dim", after)}${tokens > 0 ? theme.fg("dim", `  ${formatTokens(tokens)} tok`) : ""}`,
								width,
							),
						);
					}
					if (active.length > shown.length) {
						lines.push(
							theme.fg("dim", `  \u2026 ${active.length - shown.length} more`),
						);
					}
					return lines;
				},
			}),
			{ placement: config.placement },
		);
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", `\u2726 ${summary}`));
		if (!tick) tick = setInterval(() => render(), TICK_MS);
	}

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		render();
	});

	// The session's name, shown in the header so several sessions are tellable apart.
	pi.on("session_info_changed", async (event) => {
		const name = (event as { name?: string | undefined }).name;
		sessionName =
			typeof name === "string" && name.length > 0 ? name : undefined;
		render();
	});

	pi.on("session_shutdown", async () => {
		if (tick) {
			clearInterval(tick);
			tick = undefined;
		}
		ctx?.ui.setWidget(WIDGET_KEY, undefined);
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.events.on("subagents:spawned", (raw) => {
		const data = (raw ?? {}) as {
			id?: string;
			type?: string;
			prompt?: string;
			options?: Record<string, unknown>;
			startedAt?: number;
		};
		if (typeof data.id !== "string") return;
		// The task's subject is the most useful label; fall back to the prompt.
		const description = data.options?.description;
		const label =
			typeof description === "string" && description.trim().length > 0
				? description.trim()
				: typeof data.prompt === "string"
					? (data.prompt.trim().split("\n")[0] ?? undefined)
					: undefined;
		track(data.id, {
			type: data.type ?? "agent",
			label,
			status: "running",
			startedAt:
				typeof data.startedAt === "number" ? data.startedAt : Date.now(),
		});
		render();
	});

	pi.events.on("subagents:activity", (raw) => {
		const data = (raw ?? {}) as {
			id?: string;
			tool?: string;
			toolCalls?: number;
			usage?: unknown;
		};
		if (typeof data.id !== "string") return;
		track(data.id, {
			tool: typeof data.tool === "string" ? data.tool : undefined,
			toolCalls:
				typeof data.toolCalls === "number" ? data.toolCalls : undefined,
			usage: asUsage(data.usage),
		});
		render();
	});

	const finish = (status: Tracked["status"]) => (raw: unknown) => {
		const data = (raw ?? {}) as {
			id?: string;
			transcript?: string;
			usage?: unknown;
		};
		if (typeof data.id !== "string") return;
		track(data.id, {
			status,
			endedAt: Date.now(),
			transcript:
				typeof data.transcript === "string" ? data.transcript : undefined,
			usage: asUsage(data.usage),
		});
		render();
	};

	pi.events.on("subagents:completed", finish("completed"));
	pi.events.on("subagents:failed", finish("failed"));

	pi.registerMessageRenderer(NOTIFICATION_TYPE, (message, options, theme) => {
		const details = (message.details ?? {}) as {
			heading?: string;
			agents?: Array<Record<string, unknown>>;
		};
		const list = details.agents ?? [];
		const bad = list.filter((a) => a.status !== "completed").length;
		const head =
			theme.fg(
				bad === 0 ? "success" : "error",
				bad === 0 ? "\u2713 " : "\u2717 ",
			) + theme.fg("accent", details.heading ?? "subagents finished");
		const rows = list.map((entry) => {
			const id = String(entry.id ?? "?").slice(0, 8);
			const status = String(entry.status ?? "completed");
			const seconds = (Number(entry.durationMs ?? 0) / 1000).toFixed(1);
			const tools = Number(entry.toolCalls ?? 0);
			const icon =
				status === "completed"
					? theme.fg("success", "\u2713")
					: theme.fg("error", "\u2717");
			const result = String(entry.result ?? "")
				.replace(/\s+/g, " ")
				.trim();
			const shown = options.expanded ? result : result.slice(0, 160);
			const usage = asUsage(entry.usage);
			const tokens = tokensOf(usage);
			const spend =
				tokens > 0 || (usage?.cost ?? 0) > 0
					? `, ${formatTokens(tokens)} tok, ${formatCost(usage?.cost ?? 0)}`
					: "";
			let row = `  ${icon} ${theme.fg("accent", id)} ${theme.fg("dim", `${status} in ${seconds}s, ${tools} tool${tools === 1 ? "" : "s"}${spend}`)}`;
			if (shown)
				row += `\n    ${shown}${!options.expanded && result.length > shown.length ? theme.fg("dim", " \u2026 ctrl+o to expand") : ""}`;
			if (entry.transcript)
				row += `\n    ${theme.fg("dim", String(entry.transcript))}`;
			return row;
		});
		return new Text([head, ...rows].join("\n"), options.outputPad, 0);
	});

	pi.registerCommand("agents", {
		description: "List subagent runs (/agents <id> for one agent's detail)",
		handler: async (args, context) => {
			const id = args.trim();
			if (id.length > 0) {
				const match = [...agents.values()].find((agent) =>
					agent.id.startsWith(id),
				);
				context.ui.notify(
					match
						? `${match.id}\n  type: ${match.type}\n  status: ${match.status}\n  elapsed: ${elapsedSeconds(match).toFixed(1)}s\n  tool calls: ${match.toolCalls}${match.tool ? ` (last: ${match.tool})` : ""}${match.transcript ? `\n  transcript: ${match.transcript}` : ""}`
						: `no subagent run matching ${id}`,
					"info",
				);
				return;
			}
			const all = [...agents.values()].reverse();
			if (all.length === 0) {
				context.ui.notify("no subagent runs in this session", "info");
				return;
			}
			const lines = all.map((agent) => {
				const icon =
					agent.status === "completed"
						? "\u2713"
						: agent.status === "running"
							? "\u25cf"
							: agent.status === "queued"
								? "\u2026"
								: "\u2717";
				const tokens = tokensOf(agent.usage);
				const cost = agent.usage?.cost ?? 0;
				const spend =
					tokens > 0 || cost > 0
						? `  ${formatTokens(tokens)} tok  ${formatCost(cost)}`
						: "";
				return `${icon} ${agent.id.slice(0, 8)}  ${labelFor(agent, 44)}  ${agent.status}  ${elapsedSeconds(agent).toFixed(0)}s  ${agent.toolCalls} tools${spend}`;
			});
			const spent = agentTotals();
			const session = sessionSpend();
			context.ui.notify(
				`${activeAgents().length} active of ${all.length} runs\n` +
					`spend: session ${formatCost(session.cost)} + agents ${formatCost(spent.cost)} = ${formatCost(session.cost + spent.cost)} ` +
					`(${formatTokens(session.tokens)} + ${formatTokens(spent.tokens)} tok)\n` +
					lines.join("\n"),
				"info",
			);
		},
	});
}
