/**
 * pi-subagents-local — run subagents as slim child pi processes instead of
 * in-process SDK sessions.
 *
 * Why this exists: with @tintinweb/pi-subagents, every agent is an SDK session
 * inside the parent, so all agent bookkeeping, parsing, assembly and rendering
 * share the session's single event loop, and anything an agent leaks is retained
 * by the parent for the life of the session (a 7h session was found holding
 * 1,768 leaked socketpairs). Children here are separate processes: they get their
 * own cores, their own address space, and their leaks die when they exit.
 *
 * This speaks the @tintinweb/pi-subagents RPC protocol (v2) over pi's event bus,
 * so cc-my-pi's task layer keeps working unchanged — nothing has to be ditched.
 *
 * Wire contract (v2), verified against cc-my-pi/extensions/pi-tasks:
 *   in   subagents:rpc:ping   {requestId}                 -> data {version: 2}
 *   in   subagents:rpc:spawn  {requestId, type, prompt,
 *                              options}                    -> data {id}
 *   in   subagents:rpc:stop   {requestId, agentId}         -> data {}
 *   out  subagents:ready      {}
 *   out  subagents:completed  {id, result}
 *   out  subagents:failed     {id, error, result, status}
 * Replies go to `<channel>:reply:<requestId>` as {success, data?|error?}.
 *
 * Config: ~/.pi/agent/subagents-local.json, all keys optional —
 *   { "tools": [...], "model": "provider/id", "maxConcurrent": 8,
 *     "timeoutMs": 1800000, "extensions": false }
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	RpcClientOptions,
} from "@earendil-works/pi-coding-agent";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = 2;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** Live child ids, so a test can assert every child is torn down. */
export const liveRunIds = new Set<string>();

type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped";

interface RunOptions {
	provider?: string;
	model?: string;
	cwd?: string;
	tools?: string[];
	timeoutMs?: number;
	extensions?: boolean;
	sessionDir?: string;
}

interface Run {
	id: string;
	type: string;
	prompt: string;
	options: RunOptions;
	startedAt: number;
	status: RunStatus;
	client?: RpcClient;
	assistantText: string;
	toolCalls: number;
	usage: { inputTokens: number; outputTokens: number };
	stopRequested: boolean;
	/** Unblocks the in-flight wait when the run is stopped from outside. */
	settle?: () => void;
}

interface Config {
	tools: string[];
	model?: string;
	provider?: string;
	maxConcurrent: number;
	timeoutMs: number;
	extensions: boolean;
}

function loadConfig(): Config {
	const config: Config = {
		tools: DEFAULT_TOOLS,
		maxConcurrent: DEFAULT_MAX_CONCURRENT,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		extensions: false,
	};
	const path = join(homedir(), ".pi", "agent", "subagents-local.json");
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
			string,
			unknown
		>;
		if (
			Array.isArray(raw.tools) &&
			raw.tools.every((t) => typeof t === "string")
		)
			config.tools = raw.tools as string[];
		if (typeof raw.model === "string") config.model = raw.model;
		if (typeof raw.provider === "string") config.provider = raw.provider;
		if (typeof raw.maxConcurrent === "number" && raw.maxConcurrent > 0)
			config.maxConcurrent = Math.floor(raw.maxConcurrent);
		if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0)
			config.timeoutMs = raw.timeoutMs;
		if (typeof raw.extensions === "boolean") config.extensions = raw.extensions;
	} catch {
		// No config file, or unreadable: defaults are already correct.
	}
	return config;
}

/**
 * The CLI entry to spawn children with.
 *
 * `process.argv[1]` is how this pi was invoked, so children are the *same* build
 * as the parent — no host-identity guessing, and it works for a source checkout,
 * an npm install, or our fork. `PI_SUBAGENTS_LOCAL_CLI` overrides it (tests, and
 * hosts whose argv[1] is not a pi entry point).
 */
function resolveCliPath(): string {
	const override = process.env.PI_SUBAGENTS_LOCAL_CLI;
	if (override && override.length > 0) {
		if (!existsSync(override))
			throw new Error(`PI_SUBAGENTS_LOCAL_CLI does not exist: ${override}`);
		return override;
	}
	const argv1 = process.argv[1];
	if (argv1 && /\.(js|mjs|cjs|ts)$/.test(argv1) && existsSync(argv1))
		return argv1;
	throw new Error(
		`cannot resolve the pi entry point (process.argv[1] = ${String(argv1)})`,
	);
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

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const runs = new Map<string, Run>();
	const queue: string[] = [];
	let active = 0;
	let shuttingDown = false;

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
			options?: RunOptions;
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
			type: params.type ?? "general-purpose",
			prompt: params.prompt,
			options: params.options ?? {},
			startedAt: Date.now(),
			status: "queued",
			assistantText: "",
			toolCalls: 0,
			usage: { inputTokens: 0, outputTokens: 0 },
			stopRequested: false,
		});
		queue.push(id);
		// Spawn is answered immediately: the caller gets an id, and the outcome
		// arrives later as a subagents:completed / :failed event.
		replyOk("subagents:rpc:spawn", requestId, { id });
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
		run.stopRequested = true;
		void stopRun(run, "stopped").then(() =>
			replyOk("subagents:rpc:stop", requestId, {}),
		);
	});

	// ── Child lifecycle ────────────────────────────────────────────────────

	function buildClientOptions(run: Run): RpcClientOptions {
		const options = run.options;
		const tools = options.tools ?? config.tools;
		const sessionDir =
			options.sessionDir ??
			join(tmpdir(), "pi-subagents-local", run.id.slice(0, 8));
		try {
			mkdirSync(sessionDir, { recursive: true });
		} catch {
			// Best effort: the child creates its own directory if this fails.
		}
		// Slim by default: no extensions (so no MCP servers are duplicated per
		// agent), no skills, no prompt templates, and an explicit tool list.
		const args = ["--session-dir", sessionDir];
		if (!(options.extensions ?? config.extensions))
			args.push("--no-extensions");
		args.push(
			"--no-skills",
			"--no-prompt-templates",
			"--tools",
			tools.join(","),
		);

		const out: RpcClientOptions = { cliPath: resolveCliPath(), args };
		const cwd = options.cwd ?? process.cwd();
		out.cwd = cwd;
		const provider = options.provider ?? config.provider;
		const model = options.model ?? config.model;
		if (provider) out.provider = provider;
		if (model) out.model = model;
		return out;
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
		const client = new RpcClient(buildClientOptions(run));
		run.client = client;

		let unsubscribe: (() => void) | undefined;
		try {
			await client.start();
			if (run.stopRequested) {
				await stopRun(run, "stopped");
				return;
			}

			// Wait on the *run* finishing, not on `agent_settled`: the child can
			// settle while idle at startup, which would return an empty result. A
			// non-retrying `agent_end` is the end of this prompt's answer.
			let resolveDone: () => void = () => undefined;
			let rejectDone: (error: Error) => void = () => undefined;
			const done = new Promise<void>((resolve, reject) => {
				resolveDone = resolve;
				rejectDone = reject;
			});
			// Stopping kills the child, so the run's own wait would never settle and
			// its concurrency slot (and liveRunIds entry) would leak.
			run.settle = resolveDone;
			unsubscribe = client.onEvent((event) => {
				if (event.type === "message_end") {
					const message = (
						event as { message?: { role?: string; usage?: UsageLike } }
					).message;
					if (message?.role === "assistant") {
						const text = messageText(message);
						if (text.trim().length > 0) run.assistantText = text;
					}
					accumulateUsage(run, message?.usage);
					return;
				}
				if (event.type === "tool_execution_start") {
					run.toolCalls++;
					return;
				}
				if (event.type === "agent_end") {
					if ((event as { willRetry?: boolean }).willRetry !== true)
						resolveDone();
					return;
				}
				if (event.type === "error") {
					const message = (event as { error?: { message?: string } }).error
						?.message;
					rejectDone(
						new Error(message ? `agent error: ${message}` : "agent error"),
					);
				}
			});

			const disposition = await client.prompt(run.prompt);
			if (disposition !== "handled") {
				await withTimeout(
					done,
					run.options.timeoutMs ?? config.timeoutMs,
					`agent ${run.type} timed out`,
				);
			}
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
			run.settle = undefined;
			liveRunIds.delete(run.id);
			run.client = undefined;
			await client.stop().catch(() => undefined);
		}
	}

	async function stopRun(run: Run, status: RunStatus): Promise<void> {
		run.stopRequested = true;
		const client = run.client;
		if (client) await client.stop().catch(() => undefined);
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
		if (status === "completed") {
			pi.events.emit("subagents:completed", {
				id: run.id,
				result: result ?? "",
			});
		} else {
			pi.events.emit("subagents:failed", {
				id: run.id,
				status,
				error:
					error ??
					(status === "stopped"
						? `agent ${run.type} was stopped`
						: `agent ${run.type} produced no output`),
				result: result ?? "",
				durationMs,
				toolCalls: run.toolCalls,
				usage: run.usage,
			});
		}
		runs.delete(run.id);
	}

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		queue.length = 0;
		const running = [...runs.values()].filter(
			(run) => run.status === "running",
		);
		await Promise.all(running.map((run) => stopRun(run, "stopped")));
	});

	// Tell the task layer an engine is present; it re-pings on this event.
	pi.events.emit("subagents:ready", {});
}

interface UsageLike {
	inputTokens?: number;
	outputTokens?: number;
	input?: number;
	output?: number;
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

function accumulateUsage(run: Run, usage: UsageLike | undefined): void {
	if (!usage) return;
	const input = usage.inputTokens ?? usage.input ?? 0;
	const output = usage.outputTokens ?? usage.output ?? 0;
	run.usage.inputTokens += input;
	run.usage.outputTokens += output;
}
