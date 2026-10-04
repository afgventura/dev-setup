#!/usr/bin/env node
/**
 * Make cc-my-pi's statusline show the statuses it does not own.
 *
 * `ctx.ui.setStatus(key, text)` is how an extension puts state in the footer, and pi's
 * stock footer renders every key on one line. cc-my-pi replaces the footer with its own
 * statusline and renders a fixed five: hindsight, codex-usage, caveman, bg-terminals, mcp.
 * Everything else is dropped silently, so the state this repo's own extensions publish is
 * invisible: tasks.ts' `task:<id>` (⧗ background run / 👁 watch), loop.ts' `loop` and
 * `wakeup`, goal.ts' `goal`, pi-subagents-ui's agent count. A session waiting on a watch
 * looks idle, and the only other marker (tab-status.ts' ◔ on the tmux tab) does not exist
 * outside tmux — in cmx a session waiting on a watcher shows nothing at all.
 *
 * This renders every status the statusline does not already claim, ahead of the claimed
 * ones so a row truncated by the terminal width still shows what the session is waiting
 * on. Claimed keys are read out of the statusline itself, so a cc-my-pi release that adds
 * a segment does not double-render it.
 *
 * Idempotent, and shape-verified: if the file is not the version this knows, it reports
 * that instead of guessing. Re-run after `pi update --extensions`, which reinstalls the
 * package and drops the patch.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir =
	process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.length > 0
		? process.env.PI_CODING_AGENT_DIR
		: join(homedir(), ".pi", "agent");
const target = join(
	agentDir,
	"npm",
	"node_modules",
	"cc-my-pi",
	"extensions",
	"statusline",
	"ui-customization",
	"index.ts",
);

const MARKER = "// dev-setup: render the statuses this statusline does not claim";
// The two lines the insert goes between, whatever they are indented with (this file is
// space-indented; pi-tasks' task-widget, which cap-task-widget.mjs patches, is tabbed).
const REGION = /^([ \t]*)const statuses = footerData\.getExtensionStatuses\(\);\n\1const selectedStatuses = \[\n/m;

let source;
try {
	source = readFileSync(target, "utf-8");
} catch {
	console.log(`   statusline-armed-statuses: not applied (no ${target})`);
	process.exit(0);
}

if (source.includes(MARKER)) {
	console.log("   statusline-armed-statuses: already applied");
	process.exit(0);
}

const match = REGION.exec(source);
if (!match) {
	console.log(
		"   statusline-armed-statuses: not applied (ui-customization/index.ts is not the shape this patch knows -- re-port it)",
	);
	process.exit(0);
}

// Which keys the statusline already renders: the literal keys in the fixed segment list
// that follows. Read rather than hard-coded, so a new upstream segment is claimed
// automatically instead of rendering twice.
const regionStart = match.index;
const openBracket = source.indexOf("const selectedStatuses = [", regionStart) + "const selectedStatuses = [".length;
const filterCall = source.indexOf("].filter(", regionStart);
if (filterCall === -1) {
	console.log("   statusline-armed-statuses: not applied (the status row is not the shape this patch knows -- re-port it)");
	process.exit(0);
}
const claimed = [
	...new Set([
		...source
			.slice(openBracket, filterCall)
			.matchAll(/statuses(?:\.get\(|,\s*)"([a-z0-9-]+)"/g)
			.map((m) => m[1]),
	]),
];
if (claimed.length === 0) {
	console.log("   statusline-armed-statuses: not applied (cannot read the claimed status keys -- re-port it)");
	process.exit(0);
}

const indent = match[1];
// One indent level for nested lines, in the file's own style (it is space-indented;
// cap-task-widget.mjs patches a tabbed file, hence the tab fallback).
const step = indent.includes("\t") ? "\t" : "  ";
const body = [
	"const statuses = footerData.getExtensionStatuses();",
	MARKER,
	"// task:<id> from tasks.ts, loop/wakeup from loop.ts, the goal, subagents. Pi's stock",
	"// footer renders every extension status; this statusline renders only the ones it",
	"// names, so an armed watch or background run was visible nowhere outside tmux.",
	`const claimed = new Set([${claimed.map((key) => JSON.stringify(key)).join(", ")}]);`,
	"const armed: string[] = [];",
	"for (const [key, value] of statuses) {",
	"\tif (claimed.has(key)) continue;",
	'\tconst text = value?.replace(ANSI_PATTERN, "").trim();',
	"\tif (text) armed.push(gray(text));",
	"}",
	// `...armed,` first: a row cut off at the right edge keeps the waiting state visible.
	"const selectedStatuses = [",
	"\t...armed,",
];

const replacement = body.map((line) => indent + line.replace(/^\t/, step)).join("\n");

// The replacement is a function so `$` in the inserted text can never be read as a
// `$&`/`$1` back-reference.
writeFileSync(target, source.replace(REGION, () => `${replacement}\n`));
console.log(`   statusline-armed-statuses: applied (unclaimed statuses rendered; claimed: ${claimed.join(", ")})`);
