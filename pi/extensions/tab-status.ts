/**
 * tab-status — a working/waiting marker on the tmux tab, like Claude Code's.
 *
 *   ⋯ name    a turn is running (same glyph the sidebar uses for Claude/Codex)
 *   ◔ name    idle, but something will wake it: a /loop or schedule_wakeup
 *             timer, a background_run / watch task, a background subagent
 *     name    idle and nothing armed — it is done until you type
 *
 * The tab name itself is owned by tmux-window-name; this only prefixes it.
 * Sources of "waiting": the `globalThis.__piWaits` registry that loop.ts and
 * tasks.ts fill, plus pi-subagents' `subagents:*` events on `pi.events`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MARKERS = ["⋯", "◔"] as const;
const MARKER_RE = /^[⋯◔] /;

const waits = ((globalThis as any).__piWaits ??= { m: new Map<string, string>(), l: new Set<() => void>() }) as {
	m: Map<string, string>;
	l: Set<() => void>;
};

export default function (pi: ExtensionAPI) {
	if (!process.env.TMUX) return;

	let working = false;
	let hasUI = false;
	let applying: Promise<void> | null = null;
	let dirty = false;

	const marker = (): (typeof MARKERS)[number] | "" => (working ? "⋯" : waits.m.size > 0 ? "◔" : "");

	// tmux-window-name reads this so a rename mid-turn keeps the marker.
	const publish = () => {
		(globalThis as any).__piTabMarker = marker();
	};

	const apply = async () => {
		publish();
		if (!hasUI) return;
		if (applying) {
			dirty = true;
			return;
		}
		applying = (async () => {
			do {
				dirty = false;
				const cur = await pi.exec("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE ?? "", "#{window_name}"]);
				if (cur.code !== 0) return;
				const base = cur.stdout.trim().replace(MARKER_RE, "");
				const m = marker();
				const next = m ? `${m} ${base}` : base;
				if (next !== cur.stdout.trim()) {
					await pi.exec("tmux", ["rename-window", "-t", process.env.TMUX_PANE ?? "", next]);
				}
			} while (dirty);
		})().finally(() => {
			applying = null;
		});
		await applying;
	};

	waits.l.add(() => void apply());

	// Only the interactive parent owns the tab: pi-subagents' in-process child
	// sessions fire agent_start/agent_end too, and have no UI bound.
	const owns = (ctx: ExtensionContext) => ctx.hasUI;

	pi.on("session_start", async (_e, ctx) => {
		if (!owns(ctx)) return;
		hasUI = true;
		await apply();
	});
	pi.on("agent_start", async (_e, ctx) => {
		if (!owns(ctx)) return;
		working = true;
		await apply();
	});
	pi.on("agent_end", async (_e, ctx) => {
		if (!owns(ctx)) return;
		working = false;
		await apply();
	});
	pi.on("session_shutdown", async (_e, ctx) => {
		if (!owns(ctx)) return;
		working = false;
		waits.m.clear();
		await apply();
	});

	// Background subagents (pi-subagents) wake the parent when they finish.
	const sub = (ev: unknown, on: boolean) => {
		const id = (ev as { id?: string } | undefined)?.id;
		if (!id) return;
		if (on) waits.m.set(`sub:${id}`, `subagent ${id.slice(0, 8)}`);
		else waits.m.delete(`sub:${id}`);
		void apply();
	};
	pi.events.on("subagents:created", (ev: unknown) => sub(ev, true));
	pi.events.on("subagents:started", (ev: unknown) => sub(ev, true));
	pi.events.on("subagents:completed", (ev: unknown) => sub(ev, false));
	pi.events.on("subagents:failed", (ev: unknown) => sub(ev, false));

	pi.registerCommand("waiting", {
		description: "Show what would wake this session while it is idle (loop, wake-up, tasks, subagents)",
		handler: async (_args, ctx) => {
			const rows = [...waits.m.values()];
			ctx.ui.notify(rows.length ? `waiting on: ${rows.join(", ")}` : "nothing armed — the session is done until you type", "info");
		},
	});
}
