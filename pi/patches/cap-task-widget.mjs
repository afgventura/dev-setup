#!/usr/bin/env node
/**
 * Cap cc-my-pi's task widget so a long task list cannot eat the screen.
 *
 * Upstream (pi-tasks 1.4.1) declares `maxVisible` (default 10) and `showAll`, and its
 * settings menu saves both — but `ui/task-widget.ts` renders `for (const task of
 * tasks)`, so every task is drawn: a 34-task list is 34 rows above the editor.
 *
 * This makes the declared settings real: rows are capped at `maxVisible` (unless
 * `showAll`), open tasks are listed before completed ones so the actionable items
 * survive the cap, and a `… N more · /tasks` line says what was hidden.
 *
 * Idempotent, and shape-verified: if the file is not the version this knows, it
 * reports that instead of guessing. Re-run after `pi update --extensions`, which
 * reinstalls the package and drops the patch.
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
	"pi-tasks",
	"src",
	"ui",
	"task-widget.ts",
);

const MARKER = "// dev-setup: cap rows so a long task list cannot take the screen";
const LOOP = "\t\tfor (const task of tasks) {";
const RETURN = "\t\treturn lines;";

let source;
try {
	source = readFileSync(target, "utf-8");
} catch {
	console.log(`   cap-task-widget: not applied (no ${target})`);
	process.exit(0);
}

if (source.includes(MARKER)) {
	console.log("   cap-task-widget: already applied");
	process.exit(0);
}
if (!source.includes(LOOP) || !source.includes(RETURN)) {
	console.log("   cap-task-widget: not applied (task-widget.ts is not the shape this patch knows -- re-port it)");
	process.exit(0);
}

const insert = [
	`\t\t${MARKER}`,
	"\t\tconst maxVisible = this.config.showAll",
	"\t\t\t? tasks.length",
	"\t\t\t: Math.max(0, this.config.maxVisible ?? 10);",
	'\t\t// Open tasks first, so the actionable ones survive the cap.',
	'\t\tconst ordered = [...tasks].sort(',
	'\t\t\t(a, b) => Number(a.status === "completed") - Number(b.status === "completed"),',
	"\t\t);",
	"\t\tconst visibleTasks = ordered.slice(0, maxVisible);",
	"\t\tconst hiddenCount = tasks.length - visibleTasks.length;",
	"",
	LOOP,
].join("\n");

const tail = [
	"\t\tif (hiddenCount > 0) {",
	"\t\t\tlines.push(",
	"\t\t\t\ttruncateToWidth(",
	'\t\t\t\t\t`${indent}${theme.fg("muted", `\\u2026 ${hiddenCount} more \\u00b7 /tasks`)}`,',
	"\t\t\t\t\twidth,",
	"\t\t\t\t),",
	"\t\t\t);",
	"\t\t}",
	"",
	RETURN,
].join("\n");

let patched = source.replace(LOOP, insert);
patched = patched.replace(/\t\tfor \(const task of tasks\) \{/, "\t\tfor (const task of visibleTasks) {");
const returnIndex = patched.lastIndexOf(RETURN);
patched = `${patched.slice(0, returnIndex)}${tail}${patched.slice(returnIndex + RETURN.length)}`;

writeFileSync(target, patched);
console.log("   cap-task-widget: applied (rows capped at maxVisible, open tasks first)");
