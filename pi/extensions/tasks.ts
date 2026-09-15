/**
 * Background tasks + watchers for pi, modelled on Claude Code's
 * `run_in_background`, `Monitor`, `TaskOutput` and `TaskStop`:
 *
 *   background_run  run a command detached; the agent is woken with a
 *                   notification (exit code + output tail) when it exits
 *   watch           poll a command every N seconds until its output matches
 *                   a regex (or it exits 0); wake the agent when it does
 *   task_output     read a task's output so far
 *   task_stop       kill a task
 *
 *   /tasks          list running/finished tasks (human)
 *   /watch <cmd>    start a watch from the prompt line (human)
 *
 * Notifications arrive as a custom message that triggers a turn when the agent
 * is idle, or is queued as a follow-up when it is busy — so the agent never
 * needs to poll with sleep loops.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Task = {
	id: string;
	kind: "run" | "watch";
	command: string;
	cwd: string;
	log: string;
	started: number;
	ended?: number;
	exitCode?: number | null;
	status: "running" | "done" | "matched" | "failed" | "timeout" | "stopped";
	proc?: ChildProcess;
	timer?: NodeJS.Timeout;
	pattern?: string;
	notified?: boolean;
};

const LOG_DIR = join(homedir(), ".pi", "agent", "tasks");
const TAIL_LINES = 60;
const TAIL_BYTES = 8_000;

function tail(file: string, lines = TAIL_LINES): string {
	try {
		const size = statSync(file).size;
		const text = readFileSync(file, "utf8");
		const clipped = size > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text;
		return clipped.split("\n").slice(-lines).join("\n").trim();
	} catch {
		return "";
	}
}

function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${(s / 3600).toFixed(1)}h`;
}

export default function (pi: ExtensionAPI) {
	mkdirSync(LOG_DIR, { recursive: true });
	const tasks = new Map<string, Task>();
	let seq = 0;
	const newId = (kind: Task["kind"]) => `${kind}-${(++seq).toString(36)}${Date.now().toString(36).slice(-3)}`;

	// Wake the agent. A custom message with triggerTurn starts a turn when idle;
	// when the agent is mid-turn it is delivered as a follow-up instead.
	async function notify(task: Task, ctx: ExtensionContext, title: string, body: string) {
		if (task.notified) return;
		task.notified = true;
		ctx.ui.setStatus(`task:${task.id}`, undefined);
		await pi.sendMessage(
			{
				customType: "task-notification",
				content:
					`[task-notification] ${title}\n` +
					`id: ${task.id}\ncommand: ${task.command}\ncwd: ${task.cwd}\n` +
					`log: ${task.log}\n` +
					(body ? `\n--- output (last ${TAIL_LINES} lines) ---\n${body}\n` : "\n(no output)\n"),
				display: true,
				details: { id: task.id, status: task.status, exitCode: task.exitCode ?? null },
			},
			ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function startRun(command: string, cwd: string, timeoutS: number, ctx: ExtensionContext): Task {
		const id = newId("run");
		const log = join(LOG_DIR, `${id}.log`);
		const fd = openSync(log, "w");
		const proc = spawn("/bin/zsh", ["-lc", command], { cwd, stdio: ["ignore", fd, fd], detached: true });
		closeSync(fd);
		const task: Task = { id, kind: "run", command, cwd, log, started: Date.now(), status: "running", proc };
		tasks.set(id, task);
		ctx.ui.setStatus(`task:${id}`, ctx.ui.theme.fg("accent", `⧗ ${id}`));

		const killer = setTimeout(() => {
			if (task.status !== "running") return;
			task.status = "timeout";
			try { process.kill(-proc.pid!, "SIGTERM"); } catch {}
		}, timeoutS * 1000);

		proc.on("exit", (code) => {
			clearTimeout(killer);
			task.ended = Date.now();
			task.exitCode = code;
			if (task.status === "running") task.status = code === 0 ? "done" : "failed";
			const title =
				task.status === "timeout"
					? `background task ${id} TIMED OUT after ${timeoutS}s`
					: task.status === "stopped"
						? `background task ${id} stopped`
						: `background task ${id} ${task.status} (exit ${code}) after ${fmtDuration(task.ended - task.started)}`;
			void notify(task, ctx, title, tail(log));
		});
		return task;
	}

	function startWatch(command: string, pattern: string | undefined, intervalS: number, timeoutS: number, cwd: string, ctx: ExtensionContext): Task {
		const id = newId("watch");
		const log = join(LOG_DIR, `${id}.log`);
		const task: Task = { id, kind: "watch", command, cwd, log, started: Date.now(), status: "running", pattern };
		tasks.set(id, task);
		ctx.ui.setStatus(`task:${id}`, ctx.ui.theme.fg("accent", `👁 ${id}`));
		const re = pattern ? new RegExp(pattern, "m") : undefined;
		let polls = 0;
		let busy = false;

		const finish = (status: Task["status"], title: string, body: string) => {
			if (task.timer) clearInterval(task.timer);
			task.status = status;
			task.ended = Date.now();
			void notify(task, ctx, title, body);
		};

		const poll = () => {
			if (busy || task.status !== "running") return;
			if (Date.now() - task.started > timeoutS * 1000) {
				finish("timeout", `watch ${id} TIMED OUT after ${timeoutS}s (${polls} polls) — condition never met`, tail(log));
				return;
			}
			busy = true;
			polls += 1;
			const fd = openSync(log, "w");
			const p = spawn("/bin/zsh", ["-lc", command], { cwd, stdio: ["ignore", fd, fd] });
			closeSync(fd);
			p.on("exit", (code) => {
				busy = false;
				if (task.status !== "running") return;
				const out = tail(log, 200);
				const hit = re ? re.test(out) : code === 0;
				if (hit) {
					task.exitCode = code;
					finish("matched", `watch ${id} condition met after ${fmtDuration(Date.now() - task.started)} (${polls} polls)`, tail(log));
				}
			});
		};
		task.timer = setInterval(poll, intervalS * 1000);
		poll();
		return task;
	}

	function stopTask(id: string): string {
		const t = tasks.get(id);
		if (!t) return `no task ${id}`;
		if (t.status !== "running") return `task ${id} already ${t.status}`;
		t.status = "stopped";
		t.ended = Date.now();
		if (t.timer) clearInterval(t.timer);
		if (t.proc?.pid) { try { process.kill(-t.proc.pid, "SIGTERM"); } catch {} }
		t.notified = true; // the caller knows; no wake-up needed
		return `stopped ${id}`;
	}

	function listTasks(): string {
		if (tasks.size === 0) return "no tasks";
		return [...tasks.values()]
			.map((t) => `${t.id}  ${t.status.padEnd(8)} ${fmtDuration((t.ended ?? Date.now()) - t.started).padStart(6)}  ${t.command.slice(0, 80)}`)
			.join("\n");
	}

	pi.registerTool({
		name: "background_run",
		label: "Background run",
		description:
			"Run a shell command detached and return immediately with a task id. When the command exits you receive a " +
			"[task-notification] message with the exit code and the last lines of output, which starts your next turn. " +
			"Use for anything that takes more than ~30s (builds, test suites, deploys, long scripts). Never poll for it " +
			"with sleep loops — the notification comes to you.",
		promptSnippet: "background_run: run a long command detached; you are notified with its output when it exits",
		promptGuidelines: [
			"For commands that may take longer than ~30 seconds, use background_run and continue with other work; do not sleep-poll. You will be notified when it finishes.",
			"Never fabricate a background task's result; if asked before the notification arrives, say it is still running (task_output shows progress).",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command (run with zsh -lc)" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
			timeout_s: Type.Optional(Type.Number({ description: "Kill after this many seconds (default 3600)" })),
		}),
		executionMode: "parallel",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			const t = startRun(params.command, cwd, params.timeout_s ?? 3600, ctx);
			return {
				content: [{ type: "text", text: `started ${t.id} (pid ${t.proc?.pid}); log: ${t.log}. You'll get a [task-notification] when it exits.` }],
				details: { id: t.id },
			};
		},
	});

	pi.registerTool({
		name: "watch",
		label: "Watch",
		description:
			"Poll a shell command every interval until its output matches a regex (or, with no pattern, until it exits 0), " +
			"then wake you with a [task-notification]. Use to wait for external state you cannot be notified about: a CI run, " +
			"a deploy, a file appearing, a port opening, a log line. Returns immediately with a task id.",
		promptSnippet: "watch: poll a command until its output matches a pattern (or exits 0), then notify you",
		promptGuidelines: [
			"To wait for external state (CI, deploy, a port, a log line), use watch with a sensible interval instead of repeated manual checks.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run on each poll (zsh -lc)" }),
			pattern: Type.Optional(Type.String({ description: "Regex; when the command's output matches, the watch completes. Omit to complete when the command exits 0." })),
			interval_s: Type.Optional(Type.Number({ description: "Seconds between polls (default 30, min 2)" })),
			timeout_s: Type.Optional(Type.Number({ description: "Give up after this many seconds (default 3600)" })),
			cwd: Type.Optional(Type.String()),
		}),
		executionMode: "parallel",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const t = startWatch(
				params.command,
				params.pattern,
				Math.max(2, params.interval_s ?? 30),
				params.timeout_s ?? 3600,
				params.cwd ?? ctx.cwd,
				ctx,
			);
			return {
				content: [{ type: "text", text: `watching as ${t.id}: every ${Math.max(2, params.interval_s ?? 30)}s, ${params.pattern ? `until output matches /${params.pattern}/` : "until exit 0"}. You'll get a [task-notification].` }],
				details: { id: t.id },
			};
		},
	});

	pi.registerTool({
		name: "task_output",
		label: "Task output",
		description: "Read the output so far (or final output) of a background_run / watch task.",
		parameters: Type.Object({ id: Type.String(), lines: Type.Optional(Type.Number({ description: "How many trailing lines (default 60)" })) }),
		executionMode: "parallel",
		async execute(_id, params) {
			const t = tasks.get(params.id);
			if (!t) return { content: [{ type: "text", text: `no task ${params.id}. Known:\n${listTasks()}` }], details: {} };
			const out = tail(t.log, params.lines ?? TAIL_LINES);
			return {
				content: [{ type: "text", text: `${t.id} ${t.status}${t.exitCode != null ? ` (exit ${t.exitCode})` : ""} — ${fmtDuration((t.ended ?? Date.now()) - t.started)}\n${out || "(no output yet)"}` }],
				details: { id: t.id, status: t.status },
			};
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Task stop",
		description: "Stop a running background_run / watch task.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params, _s, _u, ctx) {
			const msg = stopTask(params.id);
			ctx.ui.setStatus(`task:${params.id}`, undefined);
			return { content: [{ type: "text", text: msg }], details: {} };
		},
	});

	pi.registerCommand("tasks", {
		description: "List background tasks and watches (/tasks stop <id>)",
		handler: async (args, ctx) => {
			const [verb, id] = args.trim().split(/\s+/);
			if (verb === "stop" && id) {
				ctx.ui.notify(stopTask(id), "info");
				ctx.ui.setStatus(`task:${id}`, undefined);
				return;
			}
			ctx.ui.notify(listTasks(), "info");
		},
	});

	pi.registerCommand("watch", {
		description: "Watch from the prompt line: /watch [every 30s] [until <regex>] <command>",
		handler: async (args, ctx) => {
			let rest = args.trim();
			let interval = 30;
			let pattern: string | undefined;
			const every = /^every\s+(\d+)s?\s+/i.exec(rest);
			if (every) { interval = Number(every[1]); rest = rest.slice(every[0].length); }
			const until = /^until\s+(\S+)\s+/i.exec(rest);
			if (until) { pattern = until[1]; rest = rest.slice(until[0].length); }
			if (!rest) { ctx.ui.notify("usage: /watch [every 30s] [until <regex>] <command>", "warning"); return; }
			const t = startWatch(rest, pattern, Math.max(2, interval), 3600, ctx.cwd, ctx);
			ctx.ui.notify(`watching as ${t.id} — /tasks to list, /tasks stop ${t.id} to cancel`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		for (const t of tasks.values()) if (t.status === "running") stopTask(t.id);
	});
}
