/**
 * Fullscreen mouse-wheel step. pi-tui scrolls ONE line per wheel event in
 * fullscreen mode (regular mode: three) and pi never passes its own
 * `wheelScrollLines` option — upstream #9052, fix unmerged as of 0.85.1 — while
 * every event repaints the whole screen (#9549). Through two tmux layers that
 * is why a trackpad flick trails behind the finger. The renderer consumes wheel
 * input before extension listeners run, so the step is set by wrapping
 * TuiAltScreen.routeWheel (the technique from the #9052 thread).
 *
 *   /wheel        show the current step
 *   /wheel 5      set it (persisted in ~/.pi/agent/wheel.json)
 *   /wheel reset  back to pi's default (1)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

const DEFAULT_LINES = 5; // same as the tmux copy-mode wheel step (-N 5) in every other pane
const DIR = join(homedir(), ".pi", "agent");
const FILE = join(DIR, "wheel.json");

function load(): number {
	try {
		const parsed = JSON.parse(readFileSync(FILE, "utf8")) as { wheelScrollLines?: unknown };
		const n = parsed.wheelScrollLines;
		if (typeof n === "number" && Number.isSafeInteger(n) && n >= 1) return n;
	} catch {
		// no file yet
	}
	return DEFAULT_LINES;
}

function save(lines: number): void {
	mkdirSync(DIR, { recursive: true });
	const tmp = `${FILE}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ wheelScrollLines: lines }, null, 2)}\n`);
	renameSync(tmp, FILE);
}

type Patched = typeof TuiAltScreen.prototype & {
	routeWheel?: (this: { wheelScrollLines: number }, event: unknown) => void;
	__wheelLines?: number;
	__wheelPatched?: boolean;
};

export default function (pi: ExtensionAPI): void {
	const proto = TuiAltScreen.prototype as Patched;
	proto.__wheelLines = load();
	if (!proto.__wheelPatched && typeof proto.routeWheel === "function") {
		const original = proto.routeWheel;
		proto.routeWheel = function (this: { wheelScrollLines: number }, event: unknown): void {
			this.wheelScrollLines = (Object.getPrototypeOf(this) as Patched).__wheelLines ?? DEFAULT_LINES;
			original.call(this, event);
		};
		proto.__wheelPatched = true;
	}

	pi.registerCommand("wheel", {
		description: "Fullscreen mouse-wheel step in lines (/wheel 5, /wheel reset)",
		argumentHint: "<lines>|reset",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (!value) {
				ctx.ui.notify(`Mouse wheel: ${proto.__wheelLines} line(s) per event (Alt: ×5)`, "info");
				return;
			}
			const lines = value === "reset" ? 1 : Number(value);
			if (!Number.isSafeInteger(lines) || lines < 1) {
				ctx.ui.notify("Usage: /wheel <positive whole number> | reset", "error");
				return;
			}
			proto.__wheelLines = lines;
			save(lines);
			ctx.ui.notify(`Mouse wheel: ${lines} line(s) per event`, "info");
		},
	});
}
