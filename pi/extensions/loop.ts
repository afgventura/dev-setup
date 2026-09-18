/**
 * /loop — re-send a prompt on a fixed interval, like Claude Code's /loop.
 *
 *   /loop 5m check CI and fix anything red     fixed interval
 *   /loop check the workers and sweep them      dynamic: the agent picks each delay
 *   /loop 30s /ralph-status
 *   /loop status
 *   /loop stop
 *
 * Interval: 30s, 5m, 1h, 90 (seconds). Runs immediately, then every interval.
 * If the agent is still busy when the tick fires, the prompt is queued as a follow-up.
 *
 * The agent can drive this itself, like Claude Code's ScheduleWakeup / /loop:
 *   schedule_wakeup(delay_s, prompt, reason)  one-shot: re-enter with `prompt` later
 *   loop_start(interval, prompt) / loop_stop() fixed-interval loop
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// What this session is waiting on while idle — read by tab-status.ts, which
// marks the tmux tab "◔" so an idle-but-armed session is distinguishable from
// one that is simply done. Kept on globalThis: extensions load as separate
// modules and must not import each other through the ~/.pi symlinks.
const waits = ((globalThis as any).__piWaits ??= { m: new Map<string, string>(), l: new Set<() => void>() }) as {
	m: Map<string, string>;
	l: Set<() => void>;
};
const setWait = (key: string, label?: string): void => {
	if (label) waits.m.set(key, label);
	else waits.m.delete(key);
	for (const f of waits.l) f();
};

type Loop = { prompt: string; ms: number; label: string; timer: NodeJS.Timeout; runs: number };

function parseInterval(raw: string): number | null {
	const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(raw.trim());
	if (!m) return null;
	const n = Number(m[1]);
	const unit = (m[2] ?? "s").toLowerCase();
	const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
	const ms = Math.round(n * mult);
	return ms >= 5_000 ? ms : null;
}

export default function (pi: ExtensionAPI) {
	let loop: Loop | undefined;

	const stop = (ctx: { ui: { setStatus: (k: string, v?: string) => void } }) => {
		if (!loop) return false;
		clearInterval(loop.timer);
		loop = undefined;
		ctx.ui.setStatus("loop", undefined);
		setWait("loop");
		return true;
	};

	let wakeup: { timer: NodeJS.Timeout; at: number; prompt: string; reason: string } | undefined;
	const clearWakeup = () => { if (wakeup) { clearTimeout(wakeup.timer); wakeup = undefined; } setWait("wakeup"); };
	const dynamicLoopPrompt = (task: string) =>
		`/loop (dynamic, self-paced) — task:\n${task}\n\n` +
		`You are in a self-paced loop. Do one pass of the task now. Then, at the END of this and every later turn, call ` +
		`schedule_wakeup(delay_s, prompt, reason) with this exact task text as the prompt and a delay you choose from what ` +
		`you are actually waiting for (30s–24h, or an absolute time via at; longer when nothing is changing, shorter when you are polling something ` +
		`fast-moving). Not calling schedule_wakeup ends the loop — do that only when the task is complete, and say so; ` +
		`the user can also end it with /loop stop.`;

	pi.registerCommand("loop", {
		description: "Run a prompt every interval: /loop 5m <prompt> | /loop status | /loop stop",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (!trimmed || trimmed === "status") {
				ctx.ui.notify(
					loop ? `loop: every ${loop.label}, ${loop.runs} run(s) so far — "${loop.prompt}"` : "no loop running",
					"info",
				);
				return;
			}

			if (trimmed === "stop") {
				const had = stop(ctx) || !!wakeup;
				clearWakeup();
				ctx.ui.setStatus("wakeup", undefined);
				ctx.ui.notify(had ? "loop stopped" : "no loop running", "info");
				return;
			}

			const [intervalRaw, ...rest] = trimmed.split(/\s+/);
			const ms = parseInterval(intervalRaw);
			if (ms === null) {
				// dynamic mode (Claude Code's /loop without an interval): the agent
				// paces itself by calling schedule_wakeup at the end of every turn
				stop(ctx);
				clearWakeup();
				ctx.ui.setStatus("loop", ctx.ui.theme.fg("accent", "↻ dynamic"));
				ctx.ui.notify("dynamic loop: the agent schedules each next run itself — /loop stop to end", "info");
				pi.sendUserMessage(dynamicLoopPrompt(trimmed), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				return;
			}
			const prompt = rest.join(" ").trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /loop [interval e.g. 5m|30s|1h] <prompt>", "warning");
				return;
			}

			stop(ctx);

			const fire = () => {
				if (!loop) return;
				loop.runs += 1;
				ctx.ui.setStatus("loop", ctx.ui.theme.fg("accent", `↻ ${loop.label} #${loop.runs}`));
				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
			};

			loop = { prompt, ms, label: intervalRaw, runs: 0, timer: setInterval(fire, ms) };
			setWait("loop", `loop ${intervalRaw}`);
			ctx.ui.notify(`loop started: every ${intervalRaw} — /loop stop to end`, "info");
			fire();
		},
	});

	// ── agent-driven ───────────────────────────────────────────────────

	pi.registerTool({
		name: "schedule_wakeup",
		label: "Schedule wake-up",
		description:
			"Re-enter this session after a delay with the given prompt, exactly like Claude Code's ScheduleWakeup. One-shot: " +
			"each firing must call schedule_wakeup again to continue the loop, or stop by not calling it (or stop: true). " +
			"Use it to self-pace a monitoring loop (\"sweep the workers\", \"check CI\") instead of sleeping or polling. " +
			"Delay is clamped to 30s–24h; pass at (\"HH:MM\" local or ISO-8601) instead of delay_s for a fixed clock time, e.g. midnight. " +
			"Only one pending wake-up at a time; a new call replaces it.",
		promptSnippet: "schedule_wakeup: re-enter later with a prompt (self-paced loop); loop_start/loop_stop: fixed-interval loop",
		promptGuidelines: [
			"To keep working on something later (waiting on workers, CI, a deploy), call schedule_wakeup with the prompt to resume with — never sleep-poll, and never tell the user to run /loop for you.",
		],
		parameters: Type.Object({
			delay_s: Type.Optional(Type.Number({ description: "Seconds until the wake-up (30–86400). Required unless at or stop is given." })),
			at: Type.Optional(Type.String({ description: "Wake at a clock time instead: \"HH:MM\" (local, next occurrence) or an ISO-8601 timestamp. Overrides delay_s." })),
			prompt: Type.Optional(Type.String({ description: "The prompt to re-enter with. Pass the same loop instruction each time. Required unless stop is true." })),
			reason: Type.Optional(Type.String({ description: "One short sentence on what you are waiting for (shown to the user)." })),
			stop: Type.Optional(Type.Boolean({ description: "true = cancel the pending wake-up and end the loop." })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.stop) {
				clearWakeup();
				ctx.ui.setStatus("wakeup", undefined);
				return { content: [{ type: "text", text: "wake-up cancelled; loop ended" }], details: {} };
			}
			let delayS = params.delay_s;
			if (params.at) {
				const m = /^(\d{1,2}):(\d{2})$/.exec(params.at.trim());
				let t: number;
				if (m) {
					const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
					if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // already past today → tomorrow
					t = d.getTime();
				} else {
					t = Date.parse(params.at);
					if (Number.isNaN(t)) return { content: [{ type: "text", text: `cannot parse at="${params.at}" — use "HH:MM" or ISO-8601` }], details: {} };
				}
				delayS = (t - Date.now()) / 1000;
			}
			if (!params.prompt || delayS == null) {
				return { content: [{ type: "text", text: "prompt and delay_s (or at) are required (or stop: true)" }], details: {} };
			}
			const delay = Math.min(86400, Math.max(30, Math.round(delayS)));
			clearWakeup();
			const prompt = params.prompt;
			const reason = params.reason ?? "";
			const at = Date.now() + delay * 1000;
			const timer = setTimeout(() => {
				wakeup = undefined;
				setWait("wakeup");
				ctx.ui.setStatus("wakeup", undefined);
				const text = `[wake-up${reason ? ` — ${reason}` : ""}]\n${prompt}`;
				if (ctx.isIdle()) pi.sendUserMessage(text);
				else pi.sendUserMessage(text, { deliverAs: "followUp" });
			}, delay * 1000);
			wakeup = { timer, at, prompt, reason };
			setWait("wakeup", `wake-up ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
			ctx.ui.setStatus("wakeup", ctx.ui.theme.fg("accent", `⏰ ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${reason ? ` · ${reason}` : ""}`));
			return {
				content: [{ type: "text", text: `wake-up scheduled in ${delay >= 3600 ? `${(delay / 3600).toFixed(1)}h` : `${delay}s`} (${new Date(at).toLocaleString()}). Nothing more to do now — end your turn; you will be re-invoked with the prompt.` }],
				details: { at, delay },
			};
		},
	});

	pi.registerTool({
		name: "loop_start",
		label: "Loop start",
		description: "Start a fixed-interval loop: re-enter this session with `prompt` every `interval` (e.g. 5m, 30s, 1h; min 5s). Same as the /loop command. Replaces any running loop.",
		parameters: Type.Object({
			interval: Type.String({ description: "e.g. 30s, 5m, 1h" }),
			prompt: Type.String(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const ms = parseInterval(params.interval);
			if (ms === null) return { content: [{ type: "text", text: "bad interval (min 5s): use 30s, 5m, 1h" }], details: {} };
			stop(ctx);
			const fire = () => {
				if (!loop) return;
				loop.runs += 1;
				ctx.ui.setStatus("loop", ctx.ui.theme.fg("accent", `↻ ${loop.label} #${loop.runs}`));
				if (ctx.isIdle()) pi.sendUserMessage(loop.prompt);
				else pi.sendUserMessage(loop.prompt, { deliverAs: "followUp" });
			};
			loop = { prompt: params.prompt, ms, label: params.interval, runs: 0, timer: setInterval(fire, ms) };
			setWait("loop", `loop ${params.interval}`);
			ctx.ui.setStatus("loop", ctx.ui.theme.fg("accent", `↻ ${params.interval} #0`));
			return { content: [{ type: "text", text: `loop started: every ${params.interval}. First run fires in ${params.interval}; end your turn.` }], details: {} };
		},
	});

	pi.registerTool({
		name: "loop_stop",
		label: "Loop stop",
		description: "Stop the running /loop (and any pending wake-up).",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const had = stop(ctx);
			clearWakeup();
			ctx.ui.setStatus("wakeup", undefined);
			return { content: [{ type: "text", text: had ? "loop stopped" : "no loop was running" }], details: {} };
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
		clearWakeup();
	});
}
