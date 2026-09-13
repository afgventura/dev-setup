/**
 * /loop — re-send a prompt on a fixed interval, like Claude Code's /loop.
 *
 *   /loop 5m check CI and fix anything red
 *   /loop 30s /ralph-status
 *   /loop status
 *   /loop stop
 *
 * Interval: 30s, 5m, 1h, 90 (seconds). Runs immediately, then every interval.
 * If the agent is still busy when the tick fires, the prompt is queued as a follow-up.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
		return true;
	};

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
				ctx.ui.notify(stop(ctx) ? "loop stopped" : "no loop running", "info");
				return;
			}

			const [intervalRaw, ...rest] = trimmed.split(/\s+/);
			const ms = parseInterval(intervalRaw);
			const prompt = rest.join(" ").trim();
			if (ms === null || !prompt) {
				ctx.ui.notify("Usage: /loop <interval e.g. 5m|30s|1h> <prompt>  (min 5s)", "warning");
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
			ctx.ui.notify(`loop started: every ${intervalRaw} — /loop stop to end`, "info");
			fire();
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});
}
