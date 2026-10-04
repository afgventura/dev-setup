/**
 * pi-subagents-local — run subagents as child pi processes instead of in-process
 * SDK sessions.
 *
 * Why: with agents running inside the session, every agent shares the session's
 * single event loop, and anything an agent leaks is retained by the parent for
 * the life of that session (a 7h session was found holding 1,768 leaked
 * socketpairs while burning ~25% of a core with no I/O). Children get their own
 * cores, their own address space, and their leaks die with the process.
 *
 * It speaks the same `subagents:rpc` v2 protocol over pi's event bus that
 * cc-my-pi's task layer expects, so that layer is unchanged.
 *
 *   in   subagents:rpc:ping   {requestId}                  -> data {version: 2}
 *   in   subagents:rpc:spawn  {requestId, type, prompt,
 *                              options}                     -> data {id}
 *   in   subagents:rpc:stop   {requestId, agentId}          -> data {}
 *   out  subagents:ready      {}
 *   out  subagents:spawned    {id, type, prompt, model, startedAt}
 *   out  subagents:activity   {id, tool, toolCalls}
 *   out  subagents:completed  {id, result, type, durationMs, toolCalls, transcript}
 *   out  subagents:failed     {id, error, result, status, type, durationMs, toolCalls, transcript, usage}
 * Replies go to `<channel>:reply:<requestId>` as {success, data?|error?}.
 *
 * Children are driven over pi's documented `--mode rpc` JSONL protocol
 * (docs/rpc.md) rather than through any host module, so this works across pi
 * versions and runtimes and needs no path assumptions.
 *
 * PORTABLE BY DESIGN — nothing here is tied to one machine, user or checkout:
 *   - the child command is auto-detected and overridable (see resolveChildCommand);
 *     unset, children are the *same* build as the parent, whether the parent was
 *     started from a source checkout, an npm install, or a compiled binary;
 *   - the config path honours PI_SUBAGENTS_LOCAL_CONFIG and PI_CODING_AGENT_DIR;
 *   - child session files go under the OS temp dir;
 *   - every flag the child gets is configurable, so a host whose pi differs can
 *     adjust it instead of editing this file.
 *
 * Config (all optional), at PI_SUBAGENTS_LOCAL_CONFIG, else
 * $PI_CODING_AGENT_DIR/subagents-local.json, else ~/.pi/agent/subagents-local.json:
 *   {
 *     "tools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
 *     "model": "provider/model-id",       // child model; default = host default
 *     "provider": "provider-name",
 *     "maxConcurrent": 16,                // fan-out cap; extras queue
 *     "timeoutMs": 0,                     // optional per-agent wall-clock limit;
 *                                          // 0/omitted = agents run until they finish
 *     "extensions": false,                // true = children load extensions/MCP too
 *     "sessionDir": "<tmpdir>/pi-subagents-local",  // or null for no --session-dir
 *     "command": "pi", "commandArgs": [], // override the child command entirely
 *     "extraArgs": []                     // appended last, for version differences
 *   }
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROTOCOL_VERSION = 2;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const DEFAULT_MAX_CONCURRENT = 16;
/**
 * There is deliberately no default wall-clock limit: an agent runs until it
 * finishes, however long its task takes. A limit exists only when the caller
 * asks for one (a spawn option) or the host config sets a positive value.
 */
/** How long a single control request (prompt, startup) may take to be acknowledged. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Grace period between SIGTERM and SIGKILL when stopping a child. */
const KILL_GRACE_MS = 5_000;
/** How many finished runs stay answerable through `get_subagent_result`. */
const FINISHED_RUN_HISTORY = 50;
/** Default window that turns a burst of completions into one notification. */
const DEFAULT_NOTIFY_BATCH_MS = 1_500;

/** Live child ids, so a test can assert every child is torn down. */
export const liveRunIds = new Set<string>();

interface Config {
	tools: string[];
	model?: string;
	provider?: string;
	maxConcurrent: number;
	/** Optional per-agent wall-clock limit. Undefined = no limit. */
	timeoutMs?: number;
	extensions: boolean;
	sessionDir: string | null;
	command?: string;
	commandArgs?: string[];
	extraArgs: string[];
	/** Where agent type definitions live. Default: <agent dir>/agents. */
	agentsDir?: string;
	/** Default agent type when a caller names none. */
	fallbackSubagent?: string;
	/** Honour agent type definitions (model, thinking, tools, prompt). */
	agentTypes: boolean;
	/**
	 * When to wake the orchestrator with a completion notification:
	 * "always" (default), "errors" (only failed/stopped), or "off".
	 */
	notify: "always" | "errors" | "off";
	/** Completions inside one window become a single notification, not one turn each. */
	notifyBatchMs: number;
}

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	return override && override.length > 0
		? override
		: join(homedir(), ".pi", "agent");
}

function configPath(): string {
	const explicit = process.env.PI_SUBAGENTS_LOCAL_CONFIG;
	if (explicit && explicit.length > 0) return explicit;
	return join(agentDir(), "subagents-local.json");
}

/**
 * Settings live in two optional places, the second overriding the first:
 *   - <agent dir>/subagents.json — shared with the old in-process engine, so the
 *     keys that still mean something here (fallbackSubagent, maxConcurrent, model,
 *     tools) keep working instead of silently doing nothing;
 *   - <agent dir>/subagents-local.json, or PI_SUBAGENTS_LOCAL_CONFIG — this engine's.
 */
function loadConfig(): Config {
	const config: Config = {
		tools: DEFAULT_TOOLS,
		maxConcurrent: DEFAULT_MAX_CONCURRENT,
		extensions: false,
		sessionDir: join(tmpdir(), "pi-subagents-local"),
		extraArgs: [],
		agentTypes: true,
		notify: "always",
		notifyBatchMs: DEFAULT_NOTIFY_BATCH_MS,
	};
	for (const path of [join(agentDir(), "subagents.json"), configPath()]) {
		try {
			applyConfig(
				config,
				JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>,
			);
		} catch {
			// Missing or unreadable file: whatever is already set stands.
		}
	}
	return config;
}

function applyConfig(config: Config, raw: Record<string, unknown>): void {
	if (
		Array.isArray(raw.tools) &&
		raw.tools.every((t) => typeof t === "string") &&
		raw.tools.length > 0
	) {
		config.tools = raw.tools as string[];
	}
	if (typeof raw.model === "string") config.model = raw.model;
	if (typeof raw.provider === "string") config.provider = raw.provider;
	if (
		typeof raw.fallbackSubagent === "string" &&
		raw.fallbackSubagent.length > 0
	) {
		config.fallbackSubagent = raw.fallbackSubagent;
	}
	if (typeof raw.maxConcurrent === "number" && raw.maxConcurrent > 0)
		config.maxConcurrent = Math.floor(raw.maxConcurrent);
	// A positive value is a wall-clock limit; 0 or a negative value means
	// explicitly unlimited (so a shared config can clear an inherited limit).
	if (typeof raw.timeoutMs === "number")
		config.timeoutMs = raw.timeoutMs > 0 ? raw.timeoutMs : undefined;
	if (typeof raw.extensions === "boolean") config.extensions = raw.extensions;
	if (raw.sessionDir === null) config.sessionDir = null;
	else if (typeof raw.sessionDir === "string" && raw.sessionDir.length > 0)
		config.sessionDir = raw.sessionDir;
	if (typeof raw.command === "string" && raw.command.length > 0)
		config.command = raw.command;
	if (
		Array.isArray(raw.commandArgs) &&
		raw.commandArgs.every((a) => typeof a === "string")
	) {
		config.commandArgs = raw.commandArgs as string[];
	}
	if (
		Array.isArray(raw.extraArgs) &&
		raw.extraArgs.every((a) => typeof a === "string")
	) {
		config.extraArgs = raw.extraArgs as string[];
	}
	if (typeof raw.agentsDir === "string" && raw.agentsDir.length > 0)
		config.agentsDir = raw.agentsDir;
	if (typeof raw.agentTypes === "boolean") config.agentTypes = raw.agentTypes;
	if (
		raw.notify === "always" ||
		raw.notify === "errors" ||
		raw.notify === "off"
	) {
		config.notify = raw.notify;
	}
	if (typeof raw.notifyBatchMs === "number" && raw.notifyBatchMs >= 0) {
		config.notifyBatchMs = raw.notifyBatchMs;
	}
}

/**
 * How to launch a child. Resolution order:
 *   1. config `command` (+ `commandArgs`) — an explicit, host-independent choice;
 *   2. PI_SUBAGENTS_LOCAL_COMMAND (a command) or PI_SUBAGENTS_LOCAL_CLI (a JS entry);
 *   3. auto: a JS entry from argv[1] run with node, so children are the parent's
 *      own build (source checkout, npm install, or the global `pi` shim);
 *   4. auto: the running executable itself, which is how a compiled/standalone pi
 *      is re-invoked.
 * Nothing is hardcoded to a particular machine, user, or install layout.
 */
function resolveChildCommand(config: Config): {
	command: string;
	commandArgs: string[];
} {
	if (config.command)
		return { command: config.command, commandArgs: config.commandArgs ?? [] };

	const envCommand = process.env.PI_SUBAGENTS_LOCAL_COMMAND;
	if (envCommand && envCommand.length > 0)
		return { command: envCommand, commandArgs: config.commandArgs ?? [] };

	const entry = process.env.PI_SUBAGENTS_LOCAL_CLI ?? process.argv[1];
	// A JS/TS entry to run with node, which covers a source checkout, an npm
	// install, and an extension-less `pi` shim (a shebang script).
	if (
		entry &&
		existsSync(entry) &&
		(/\.(js|mjs|cjs|ts)$/.test(entry) || hasShebang(entry))
	) {
		return { command: "node", commandArgs: [entry] };
	}
	// Otherwise the running executable is pi itself (compiled/standalone build).
	return { command: process.execPath, commandArgs: [] };
}

function hasShebang(path: string): boolean {
	try {
		const fd = openSync(path, "r");
		try {
			const head = Buffer.alloc(2);
			readSync(fd, head, 0, 2, 0);
			return head.toString("utf-8") === "#!";
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

/** Assistant text arrives as either a string or content parts, depending on the message. */
function messageText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const record = part as { type?: string; text?: unknown };
		if (record.type === "text" && typeof record.text === "string")
			parts.push(record.text);
	}
	return parts.join("\n");
}

/**
 * Token usage and cost for one run. pi reports cost as four components (each in
 * USD), priced from the model catalogue, so they are summed into one figure.
 */
interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function emptyUsage(): AgentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

interface UsageLike {
	input?: number;
	output?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?:
		| number
		| {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
		  };
}

function costOf(cost: UsageLike["cost"]): number {
	if (typeof cost === "number") return cost;
	if (!cost) return 0;
	return (
		(cost.input ?? 0) +
		(cost.output ?? 0) +
		(cost.cacheRead ?? 0) +
		(cost.cacheWrite ?? 0)
	);
}

/**
 * One child pi in `--mode rpc`, driven over JSONL: requests go in on stdin as
 * `{...command, id}`, and everything the child says comes back on stdout as
 * either `{type:"response", id, success, data|error}` or an event line.
 */
class ChildAgent {
	private child: ChildProcess | undefined;
	private nextRequestId = 0;
	private readonly pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private readonly eventListeners: Array<
		(event: Record<string, unknown>) => void
	> = [];
	private readonly exitListeners: Array<(error: Error) => void> = [];
	private stderrTail = "";
	private exited: { code: number | null; signal: string | null } | undefined;
	private exitError: Error | undefined;
	private exitNotified = false;
	private stopping = false;

	private readonly command: string;
	private readonly commandArgs: string[];
	private readonly cwd: string;

	// Fields are assigned explicitly rather than via parameter properties:
	// this repo is erasable-TypeScript-only, and parameter properties are not.
	constructor(command: string, commandArgs: string[], cwd: string) {
		this.command = command;
		this.commandArgs = commandArgs;
		this.cwd = cwd;
	}

	/** The child's process id, for the run-state file. */
	get pid(): number | undefined {
		return this.child?.pid;
	}

	start(): Promise<void> {
		const child = spawn(this.command, this.commandArgs, {
			cwd: this.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			// Its own process group, so stopping the agent can stop the work it
			// started too (a build, a test run, a long bash). Killing only the
			// agent leaves those running as orphans.
			detached: process.platform !== "win32",
		});
		this.child = child;

		const stdout = child.stdout;
		if (!stdout) {
			child.kill("SIGKILL");
			return Promise.reject(new Error("child pi has no stdout"));
		}
		createInterface({ input: stdout }).on("line", (line) =>
			this.handleLine(line),
		);
		child.stderr?.on("data", (data: Buffer) => {
			this.stderrTail = (this.stderrTail + data.toString()).slice(-2_000);
		});
		child.once("exit", (code, signal) => {
			if (this.exited) return;
			this.exited = { code, signal };
			const detail =
				this.stderrTail.trim().length > 0
					? `: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ")}`
					: "";
			const error = new Error(
				`child pi exited (code=${String(code)}, signal=${String(signal)})${detail}`,
			);
			this.rejectPending(error);
			this.notifyExit(error);
		});
		child.once("error", (error) => {
			// A spawn failure (ENOENT, EACCES) may never emit `exit`, so treat it as
			// terminal too — otherwise an unbounded run would wait forever.
			const failure =
				error instanceof Error ? error : new Error(String(error));
			if (!this.exited) this.exited = { code: null, signal: null };
			this.rejectPending(failure);
			this.notifyExit(failure);
		});

		// Resolves once the child is up; rejects if it never starts (a bad command
		// emits `error` and no `spawn`), so the caller is never left waiting on a
		// process that does not exist.
		return new Promise<void>((resolve, reject) => {
			if (child.pid) {
				resolve();
				return;
			}
			child.once("spawn", () => resolve());
			child.once("error", (error) =>
				reject(error instanceof Error ? error : new Error(String(error))),
			);
		});
	}

	private handleLine(line: string): void {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return; // Not JSONL we understand; ignore rather than crash the run.
		}
		if (data.type === "response" && typeof data.id === "string") {
			const pending = this.pending.get(data.id);
			if (!pending) return;
			this.pending.delete(data.id);
			if (data.success === false)
				pending.reject(new Error(String(data.error ?? "child command failed")));
			else pending.resolve(data.data);
			return;
		}
		for (const listener of [...this.eventListeners]) listener(data);
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of [...this.pending]) {
			this.pending.delete(id);
			pending.reject(error);
		}
	}

	request(
		command: Record<string, unknown>,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		const child = this.child;
		const stdin = child?.stdin;
		if (!stdin || stdin.destroyed)
			return Promise.reject(new Error("child pi is not running"));
		if (this.exited)
			return Promise.reject(
				new Error(`child pi exited (code=${String(this.exited.code)})`),
			);
		const id = `req_${++this.nextRequestId}`;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`child pi did not acknowledge ${String(command.type)}`),
				);
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	onEvent(listener: (event: Record<string, unknown>) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index >= 0) this.eventListeners.splice(index, 1);
		};
	}

	/**
	 * Called once when the child dies — a crash, a kill, or a failure to start.
	 * None of those produce an `agent_end`, so without this an unbounded run would
	 * wait for an event that will never come. A listener added after the fact is
	 * called immediately with the recorded error.
	 */
	onExit(listener: (error: Error) => void): () => void {
		if (this.exitNotified && this.exitError) {
			listener(this.exitError);
			return () => undefined;
		}
		this.exitListeners.push(listener);
		return () => {
			const index = this.exitListeners.indexOf(listener);
			if (index >= 0) this.exitListeners.splice(index, 1);
		};
	}

	private notifyExit(error: Error): void {
		if (this.exitNotified) return;
		this.exitNotified = true;
		this.exitError = error;
		for (const listener of [...this.exitListeners]) listener(error);
	}

	/** SIGTERM, then SIGKILL if the child does not go away. Resolves when it is gone. */
	/** Signal the child's whole process group, falling back to the child alone. */
	private signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
		const pid = child.pid;
		if (pid && process.platform !== "win32") {
			try {
				// Negative pid targets the group the child leads (detached above).
				process.kill(-pid, signal);
				return;
			} catch {
				// Group already gone, or no group: fall through.
			}
		}
		try {
			child.kill(signal);
		} catch {
			// Already dead.
		}
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child || this.stopping) return;
		this.stopping = true;
		if (this.exited || child.exitCode !== null) return;
		const gone = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			setTimeout(() => {
				this.signalGroup(child, "SIGKILL");
				resolve();
			}, KILL_GRACE_MS).unref();
		});
		this.signalGroup(child, "SIGTERM");
		await gone;
	}
}

interface Run {
	id: string;
	type: string;
	prompt: string;
	options: Record<string, unknown>;
	startedAt: number;
	status: "queued" | "running" | "completed" | "failed" | "stopped";
	agent?: ChildAgent;
	assistantText: string;
	toolCalls: number;
	usage: AgentUsage;
	stopRequested: boolean;
	/** Last tool the agent called, for the live view. */
	lastTool?: string;
	/** Child process id, once started, so a reloading engine can find it again. */
	pid?: number;
	/** Unblocks the in-flight wait when the run is stopped from outside. */
	settle?: () => void;
}

interface FinishedRun {
	result: string;
	transcript?: string;
	status: RunStatus;
	finishedAt: number;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface AgentType {
	name: string;
	description?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	/** Body of the file, i.e. the agent's own system prompt, when it has one. */
	prompt?: string;
	promptMode: "append" | "replace";
}

function parseList(value: string): string[] {
	return value
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((entry) => entry.trim().replace(/^["'](.*)["']$/, "$1"))
		.filter((entry) => entry.length > 0);
}

/**
 * An agent type definition: YAML frontmatter plus optional body, the same shape
 * the agent dir already uses. Only the keys that change how a child runs are
 * read; anything else is ignored rather than rejected.
 */
export function parseAgentFile(text: string, name: string): AgentType {
	const agent: AgentType = { name, promptMode: "append" };
	let body = text;
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (frontmatter) {
		body = text.slice(frontmatter[0].length);
		for (const line of frontmatter[1].split(/\r?\n/)) {
			const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
			if (!pair) continue;
			const key = pair[1].toLowerCase();
			const value = pair[2].trim().replace(/^["'](.*)["']$/, "$1");
			if (key === "model") agent.model = value;
			else if (key === "thinking") agent.thinking = value;
			else if (key === "description") agent.description = value;
			else if (key === "prompt_mode")
				agent.promptMode = value === "replace" ? "replace" : "append";
			else if (key === "tools") agent.tools = parseList(value);
		}
	}
	const trimmed = body.trim();
	if (trimmed.length > 0) agent.prompt = trimmed;
	return agent;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const runs = new Map<string, Run>();
	const finishedRuns = new Map<string, FinishedRun>();
	const queue: string[] = [];
	let active = 0;
	let shuttingDown = false;
	let latestCtx: ExtensionContext | undefined;

	/**
	 * A reload re-imports this module — the loader runs with `moduleCache: false` —
	 * so an in-flight child loses the pipes this instance holds, sees stdin EOF, and
	 * exits. Nothing would tell the orchestrator, leaving its tasks stuck in flight.
	 * So the running set is mirrored to disk, keyed by this session's process id, and
	 * the next instance to load reports them as interrupted.
	 */
	function runStatePath(): string {
		return join(tmpdir(), "pi-subagents-local", `runs-${process.pid}.json`);
	}

	function saveRunState(): void {
		const live = [...runs.values()]
			.filter((run) => run.status === "running" || run.status === "queued")
			.map((run) => ({
				id: run.id,
				type: run.type,
				pid: run.pid,
				startedAt: run.startedAt,
			}));
		const path = runStatePath();
		try {
			if (live.length === 0) {
				rmSync(path, { force: true });
				return;
			}
			mkdirSync(join(tmpdir(), "pi-subagents-local"), { recursive: true });
			writeFileSync(path, JSON.stringify({ pid: process.pid, runs: live }));
		} catch {
			// Best effort: losing this only means an interruption goes unreported.
		}
	}

	/** Report the previous instance's in-flight runs as interrupted, and clean up. */
	function recoverInterruptedRuns(): void {
		const path = runStatePath();
		let previous: Array<{ id?: string; type?: string; pid?: number }> = [];
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
				runs?: typeof previous;
			};
			previous = parsed.runs ?? [];
		} catch {
			return;
		}
		rmSync(path, { force: true });
		for (const entry of previous) {
			if (typeof entry.id !== "string") continue;
			// Its pipes died with the previous instance, so it has already seen EOF;
			// signal the group anyway in case the process is still winding down.
			if (typeof entry.pid === "number" && process.platform !== "win32") {
				try {
					process.kill(-entry.pid, "SIGTERM");
				} catch {
					// Already gone.
				}
			}
			pi.events.emit("subagents:failed", {
				id: entry.id,
				type: entry.type ?? "agent",
				status: "interrupted",
				error:
					"agent was interrupted: the extension host reloaded while it was running, so it is not running now. Re-run it if its work is still needed.",
				result: "",
				durationMs: 0,
				toolCalls: 0,
			});
		}
	}
	let notifyTimer: ReturnType<typeof setTimeout> | undefined;
	const notifyQueue: Array<Record<string, unknown>> = [];

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
	});

	/**
	 * Wake the orchestrator when agents finish. A burst (a fan-out landing
	 * together) is collapsed into a single message so N agents cost one turn
	 * rather than N — the old engine sent one notification per agent.
	 */
	function queueNotification(entry: Record<string, unknown>): void {
		if (config.notify === "off") return;
		if (config.notify === "errors" && entry.status === "completed") return;
		notifyQueue.push(entry);
		if (notifyTimer) return;
		notifyTimer = setTimeout(() => {
			notifyTimer = undefined;
			void flushNotifications();
		}, config.notifyBatchMs);
		notifyTimer.unref?.();
	}

	async function flushNotifications(): Promise<void> {
		const batch = notifyQueue.splice(0, notifyQueue.length);
		if (batch.length === 0) return;
		const one = batch.length === 1 ? (batch[0] as { id?: string }) : undefined;
		const heading =
			batch.length === 1 && one?.id
				? `subagent ${one.id} finished`
				: `${batch.length} subagents finished`;
		const lines = batch.map((entry) => {
			const id = String(entry.id ?? "?");
			const type = String(entry.type ?? "agent");
			const status = String(entry.status ?? "completed");
			const seconds = (Number(entry.durationMs ?? 0) / 1000).toFixed(1);
			const tools = Number(entry.toolCalls ?? 0);
			const result = String(entry.result ?? "").trim();
			return (
				`- ${id} (${type}) ${status} in ${seconds}s, ${tools} tool call${tools === 1 ? "" : "s"}` +
				(result
					? `\n  result: ${result.length > 1200 ? `${result.slice(0, 1200)}\u2026` : result}`
					: "") +
				(entry.transcript ? `\n  transcript: ${String(entry.transcript)}` : "")
			);
		});
		const content =
			`[subagent-notification] ${heading}\n${lines.join("\n")}\n\n` +
			"Act on these results. Use get_subagent_result with an agent id for the full result of any of them.";
		try {
			const options =
				latestCtx && !latestCtx.isIdle()
					? { triggerTurn: true, deliverAs: "followUp" as const }
					: { triggerTurn: true };
			await pi.sendMessage(
				{
					customType: "subagent-notification",
					content,
					display: true,
					details: { heading, agents: batch },
				},
				options,
			);
		} catch {
			// A host that cannot deliver messages (headless) still keeps the results
			// in the task store and get_subagent_result.
		}
	}

	function reply(
		channel: string,
		requestId: string,
		payload: Record<string, unknown>,
	): void {
		pi.events.emit(`${channel}:reply:${requestId}`, payload);
	}

	function replyOk(
		channel: string,
		requestId: string,
		data: Record<string, unknown> = {},
	): void {
		reply(channel, requestId, { success: true, data });
	}

	function replyError(channel: string, requestId: string, error: string): void {
		reply(channel, requestId, { success: false, error });
	}

	// ── RPC surface ────────────────────────────────────────────────────────

	pi.events.on("subagents:rpc:ping", (raw) => {
		const { requestId } = (raw ?? {}) as { requestId?: string };
		if (typeof requestId !== "string") return;
		replyOk("subagents:rpc:ping", requestId, { version: PROTOCOL_VERSION });
	});

	pi.events.on("subagents:rpc:spawn", (raw) => {
		const params = (raw ?? {}) as {
			requestId?: string;
			type?: string;
			prompt?: string;
			options?: Record<string, unknown>;
		};
		const { requestId } = params;
		if (typeof requestId !== "string") return;
		if (typeof params.prompt !== "string" || params.prompt.length === 0) {
			replyError(
				"subagents:rpc:spawn",
				requestId,
				"spawn requires a non-empty prompt",
			);
			return;
		}
		if (shuttingDown) {
			replyError("subagents:rpc:spawn", requestId, "session is shutting down");
			return;
		}
		const id = randomUUID();
		runs.set(id, {
			id,
			type: params.type ?? fallbackAgentType(),
			prompt: params.prompt,
			options: params.options ?? {},
			startedAt: Date.now(),
			status: "queued",
			assistantText: "",
			toolCalls: 0,
			usage: emptyUsage(),
			stopRequested: false,
		});
		queue.push(id);
		saveRunState();
		// Answered immediately: the caller gets an id and the outcome arrives later
		// as subagents:completed / :failed.
		replyOk("subagents:rpc:spawn", requestId, { id });
		// Announced for UI/observability consumers; the task layer only needs the reply.
		pi.events.emit("subagents:spawned", {
			id,
			type: params.type ?? fallbackAgentType(),
			prompt: params.prompt,
			// Passed through so a view can label the run with the caller's description
			// (pi-tasks sends the task subject here) instead of a bare agent type.
			options: params.options ?? {},
			model: config.model,
			startedAt: Date.now(),
		});
		void pump();
	});

	pi.events.on("subagents:rpc:stop", (raw) => {
		const { requestId, agentId } = (raw ?? {}) as {
			requestId?: string;
			agentId?: string;
		};
		if (typeof requestId !== "string") return;
		const run = typeof agentId === "string" ? runs.get(agentId) : undefined;
		if (!run) {
			replyOk("subagents:rpc:stop", requestId, {});
			return;
		}
		void stopRun(run, "stopped").then(() =>
			replyOk("subagents:rpc:stop", requestId, {}),
		);
	});

	// ── Child lifecycle ────────────────────────────────────────────────────

	/** Where this run's child writes its session, or undefined when disabled. */
	function sessionDirFor(run: Run): string | undefined {
		const options = run.options;
		const root =
			options.sessionDir === null
				? null
				: (asString(options.sessionDir) ?? config.sessionDir);
		return root ? join(root, run.id.slice(0, 8)) : undefined;
	}

	/**
	 * The child's own transcript (newest session file in its session dir). The
	 * parent gets a pointer to it, so a thin summary can be followed up and the
	 * orchestrator stays able to see what an agent actually did.
	 */
	function transcriptPathFor(run: Run): string | undefined {
		const dir = sessionDirFor(run);
		if (!dir) return undefined;
		try {
			const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
			if (files.length === 0) return undefined;
			files.sort();
			return join(dir, files[files.length - 1]);
		} catch {
			return undefined;
		}
	}

	const agentTypeCache = new Map<string, AgentType | null>();

	/** Where agent type definitions live. */
	function agentsDirPath(): string {
		return config.agentsDir ?? join(agentDir(), "agents");
	}

	/** An unknown type runs with the defaults rather than failing the spawn. */
	function loadAgentType(type: string): AgentType | null {
		if (!config.agentTypes) return null;
		const cached = agentTypeCache.get(type);
		if (cached !== undefined) return cached;
		let agent: AgentType | null;
		try {
			agent = parseAgentFile(
				readFileSync(join(agentsDirPath(), `${type}.md`), "utf-8"),
				type,
			);
		} catch {
			agent = null;
		}
		agentTypeCache.set(type, agent);
		return agent;
	}

	/** The default type when a caller does not name one. */
	function fallbackAgentType(): string {
		return config.fallbackSubagent ?? "general-purpose";
	}

	function childArgs(run: Run): string[] {
		const options = run.options;
		// An agent type definition supplies the model, thinking level, tool list and
		// system prompt; explicit per-run options win over it, and it wins over the
		// extension-wide config.
		const agent = loadAgentType(run.type);
		const tools =
			Array.isArray(options.tools) &&
			options.tools.every((t) => typeof t === "string")
				? (options.tools as string[])
				: (agent?.tools ?? config.tools);
		const args = ["--mode", "rpc"];
		const provider = asString(options.provider) ?? config.provider;
		const model = asString(options.model) ?? agent?.model ?? config.model;
		if (provider) args.push("--provider", provider);
		if (model) args.push("--model", model);
		const thinking = asString(options.thinking) ?? agent?.thinking;
		if (thinking) args.push("--thinking", thinking);
		if (agent?.prompt) {
			args.push(
				agent.promptMode === "append"
					? "--append-system-prompt"
					: "--system-prompt",
				agent.prompt,
			);
		}

		const sessionDir = sessionDirFor(run);
		if (sessionDir) {
			try {
				mkdirSync(sessionDir, { recursive: true });
			} catch {
				// Best effort: the child creates its own session directory.
			}
			args.push("--session-dir", sessionDir);
		}

		// Slim by default: no extensions, so no MCP servers are duplicated per agent.
		const extensions =
			typeof options.extensions === "boolean"
				? options.extensions
				: config.extensions;
		if (!extensions) args.push("--no-extensions");
		args.push(
			"--no-skills",
			"--no-prompt-templates",
			"--tools",
			tools.join(","),
		);
		args.push(...config.extraArgs);
		return args;
	}

	async function pump(): Promise<void> {
		while (!shuttingDown && active < config.maxConcurrent && queue.length > 0) {
			const id = queue.shift();
			const run = id ? runs.get(id) : undefined;
			if (!run || run.status !== "queued") continue;
			active++;
			void executeRun(run).finally(() => {
				active--;
				if (queue.length > 0 && !shuttingDown) void pump();
			});
		}
	}

	async function executeRun(run: Run): Promise<void> {
		run.status = "running";
		liveRunIds.add(run.id);
		const { command, commandArgs } = resolveChildCommand(config);
		const agent = new ChildAgent(
			command,
			[...commandArgs, ...childArgs(run)],
			asString(run.options.cwd) ?? process.cwd(),
		);
		run.agent = agent;

		let unsubscribe: (() => void) | undefined;
		let unsubscribeExit: (() => void) | undefined;
		let rejectDone: (error: Error) => void = () => undefined;
		try {
			await agent.start();
			run.pid = agent.pid;
			saveRunState();
			if (run.stopRequested) {
				await stopRun(run, "stopped");
				return;
			}

			// Wait on the *run* finishing, not on `agent_settled`: a child can settle
			// while idle at startup, which would return an empty result. A
			// non-retrying `agent_end` is the end of this prompt's answer.
			let resolveDone: () => void = () => undefined;
			const done = new Promise<void>((resolve, reject) => {
				resolveDone = resolve;
				rejectDone = reject;
			});
			// The prompt request below can fail on its own (the child dies before
			// acknowledging it), rejecting `done` before anything awaits it. Mark it
			// handled so that is not an unhandled rejection; awaiting it later still
			// throws into this function's catch.
			done.catch(() => undefined);
			// Stopping kills the child, so the run's own wait would never settle and
			// its concurrency slot would leak.
			run.settle = resolveDone;
			// A crash, a kill or a failed start produces no `agent_end`; fail the run
			// instead of waiting on an event that will never arrive.
			unsubscribeExit = agent.onExit((error) => rejectDone(error));

			unsubscribe = agent.onEvent((event) => {
				if (event.type === "message_end") {
					const message = event.message as
						| { role?: string; usage?: UsageLike }
						| undefined;
					if (message?.role === "assistant") {
						const text = messageText(message);
						if (text.trim().length > 0) run.assistantText = text;
					}
					accumulateUsage(run, message?.usage);
					return;
				}
				if (event.type === "tool_execution_start") {
					run.toolCalls++;
					const tool = (event as { toolName?: string }).toolName;
					if (typeof tool === "string") run.lastTool = tool;
					pi.events.emit("subagents:activity", {
						id: run.id,
						tool: run.lastTool,
						toolCalls: run.toolCalls,
						// So a view can show tokens/cost for a run that is still going.
						usage: run.usage,
					});
					return;
				}
				if (event.type === "agent_end") {
					if (event.willRetry !== true) resolveDone();
					return;
				}
				if (event.type === "error") {
					const message = (event.error as { message?: string } | undefined)
						?.message;
					rejectDone(
						new Error(message ? `agent error: ${message}` : "agent error"),
					);
				}
			});

			await agent.request({ type: "prompt", message: run.prompt });
			// No wall-clock limit by default: the agent runs until it finishes. A
			// positive per-run option (the orchestrator asking for one) wins over the
			// host config; 0 or a negative value there means "no limit" too.
			const timeoutMs =
				typeof run.options.timeoutMs === "number"
					? run.options.timeoutMs > 0
						? run.options.timeoutMs
						: undefined
					: config.timeoutMs;
			if (timeoutMs === undefined) await done;
			else await withTimeout(done, timeoutMs, `agent ${run.type} timed out`);
			if (run.stopRequested) {
				await stopRun(run, "stopped");
				return;
			}
			finish(run, "completed", run.assistantText);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (run.stopRequested) {
				await stopRun(run, "stopped");
				return;
			}
			finish(run, "failed", run.assistantText || undefined, message);
		} finally {
			unsubscribe?.();
			unsubscribeExit?.();
			run.settle = undefined;
			liveRunIds.delete(run.id);
			run.agent = undefined;
			await agent.stop();
		}
	}

	async function stopRun(run: Run, status: RunStatus): Promise<void> {
		run.stopRequested = true;
		await run.agent?.stop();
		// Release the run's own wait so executeRun can finish and free its slot.
		run.settle?.();
		if (run.status === "queued" || run.status === "running")
			finish(run, status, run.assistantText || undefined);
	}

	function finish(
		run: Run,
		status: RunStatus,
		result?: string,
		error?: string,
	): void {
		if (
			run.status === "completed" ||
			run.status === "failed" ||
			run.status === "stopped"
		)
			return;
		run.status = status;
		const durationMs = Date.now() - run.startedAt;
		const transcript = transcriptPathFor(run);
		const withPointer = (text: string): string =>
			transcript ? `${text}\n\n[full child transcript: ${transcript}]` : text;
		if (status === "completed") {
			pi.events.emit("subagents:completed", {
				id: run.id,
				result: withPointer(result ?? ""),
				type: run.type,
				durationMs,
				toolCalls: run.toolCalls,
				transcript,
				usage: run.usage,
			});
		} else {
			pi.events.emit("subagents:failed", {
				id: run.id,
				status,
				type: run.type,
				error:
					error ??
					(status === "stopped"
						? `agent ${run.type} was stopped`
						: `agent ${run.type} produced no output`),
				result: withPointer(result ?? ""),
				durationMs,
				toolCalls: run.toolCalls,
				transcript,
				usage: run.usage,
			});
		}
		finishedRuns.set(run.id, {
			result: result ?? "",
			transcript,
			status,
			finishedAt: Date.now(),
		});
		queueNotification({
			id: run.id,
			type: run.type,
			status,
			result: result ?? "",
			durationMs,
			toolCalls: run.toolCalls,
			transcript,
			usage: run.usage,
			error,
		});
		if (finishedRuns.size > FINISHED_RUN_HISTORY) {
			const oldest = finishedRuns.keys().next().value;
			if (typeof oldest === "string") finishedRuns.delete(oldest);
		}
		runs.delete(run.id);
		saveRunState();
	}

	// A caller that learned to reach for `get_subagent_result` (it used to come
	// from the in-process engine) gets the real result instead of a dead end.
	pi.registerTool({
		name: "get_subagent_result",
		label: "Get subagent result",
		description:
			"Read a subagent's full result by agent id — use it when a task's returned summary was truncated or you " +
			"need what an agent actually produced. Also reports progress for an agent that is still running, and points " +
			"at the agent's full transcript so you can read the detail yourself.",
		promptSnippet:
			"get_subagent_result: read a subagent's full result by agent id when its summary is truncated",
		parameters: Type.Object({
			agent_id: Type.String({
				description:
					"Agent id returned by the spawn/TaskExecute that started it",
			}),
		}),
		async execute(_id, params) {
			const running = runs.get(params.agent_id);
			if (running) {
				const partial = running.assistantText.trim();
				return {
					content: [
						{
							type: "text",
							text: `agent ${params.agent_id} is still ${running.status}.${partial ? `\n\nOutput so far:\n${partial}` : " No output yet."}`,
						},
					],
					details: { status: running.status },
				};
			}
			const finished = finishedRuns.get(params.agent_id);
			if (!finished) {
				return {
					content: [
						{
							type: "text",
							text: `No subagent run with id ${params.agent_id} in this session (only the last ${FINISHED_RUN_HISTORY} finished runs are kept).`,
						},
					],
					details: { status: "unknown" },
				};
			}
			const parts = [
				finished.result.trim() || "(the agent produced no output)",
			];
			if (finished.transcript)
				parts.push(`[full child transcript: ${finished.transcript}]`);
			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: { status: finished.status, transcript: finished.transcript },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		queue.length = 0;
		const running = [...runs.values()].filter(
			(run) => run.status === "running",
		);
		await Promise.all(running.map((run) => stopRun(run, "stopped")));
	});

	// A previous instance may have been reloaded out from under running children;
	// report those before anything else, so their tasks do not sit in flight.
	recoverInterruptedRuns();

	// Tell the task layer an engine is present; it re-pings on this event.
	pi.events.emit("subagents:ready", {});
}

type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped";

function accumulateUsage(run: Run, usage: UsageLike | undefined): void {
	if (!usage) return;
	run.usage.input += usage.inputTokens ?? usage.input ?? 0;
	run.usage.output += usage.outputTokens ?? usage.output ?? 0;
	run.usage.cacheRead += usage.cacheRead ?? 0;
	run.usage.cacheWrite += usage.cacheWrite ?? 0;
	run.usage.cost += costOf(usage.cost);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
