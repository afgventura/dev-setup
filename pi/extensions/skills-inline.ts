/**
 * Reference any number of skills anywhere in a prompt, Claude Code style.
 *
 *   /repo-safety then /backend: add a retry to the CDC handler
 *   fix the flaky test — load /testing and /script-runtime first
 *
 * pi's own `/skill:name` is a *command*: it only works as the first token of a
 * message and takes one skill. This extension rewrites the message before it
 * reaches the model, replacing every `/name` or `/skill:name` that matches a
 * discovered skill with the full SKILL.md (each skill once, in order of first
 * mention). Words that are not a skill name are left alone, so `/tmp/x` or
 * `a/b` are safe. A message that is only `/skill:name …` is left to pi's own
 * command handling.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSkills, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const AGENT_DIR = join(homedir(), ".pi", "agent");

export default function (pi: ExtensionAPI) {
	let byName = new Map<string, string>(); // name → SKILL.md path
	let loadedFor = "";

	const refresh = (cwd: string) => {
		if (loadedFor === cwd && byName.size) return;
		const found = new Map<string, string>();
		const add = (skills: { name: string; filePath: string }[]) => {
			for (const sk of skills) if (!found.has(sk.name)) found.set(sk.name, sk.filePath);
		};
		try {
			add(loadSkills({ cwd, agentDir: AGENT_DIR, skillPaths: [], includeDefaults: true }).skills);
		} catch {}
		// project skills: .pi/skills and .agents/skills in cwd and its ancestors
		// (loadSkills only returns these once the project is trusted, which is
		// after this handler on the first message)
		let dir = cwd;
		for (;;) {
			for (const sub of [".pi/skills", ".agents/skills", ".claude/skills"]) {
				const d = join(dir, sub);
				if (existsSync(d)) { try { add(loadSkillsFromDir({ dir: d, source: "project" }).skills); } catch {} }
			}
			if (existsSync(join(dir, ".git"))) break;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		if (found.size) { byName = found; loadedFor = cwd; }
	};

	// keep in sync with what pi itself loaded (covers /reload and custom skill paths)
	pi.on("before_agent_start", async (event) => {
		const skills = event.systemPromptOptions?.skills;
		for (const sk of skills ?? []) if (!byName.has(sk.name)) byName.set(sk.name, sk.filePath);
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text;
		if (!text.includes("/")) return;
		if (/^\/skill:[a-z0-9-]+(\s|$)/.test(text.trimStart())) return; // pi's own command
		refresh(ctx.cwd);
		if (!byName.size) return;

		const seen: string[] = [];
		// a mention is `/name` or `/skill:name` at a word boundary, not part of a path
		const re = /(^|[\s(,;:])\/(?:skill:)?([a-z0-9][a-z0-9-]*)(?=$|[\s.,;:)!?])/g;
		let rewritten = text.replace(re, (m, lead: string, name: string) => {
			if (!byName.has(name)) return m;
			if (!seen.includes(name)) seen.push(name);
			return m; // keep the user's text as typed
		});
		if (!seen.length) return;

		const blocks = seen.map((name) => {
			const path = byName.get(name)!;
			let body = "";
			try {
				body = readFileSync(path, "utf8");
			} catch {
				body = `(could not read ${path})`;
			}
			return `<skill name="${name}" path="${path}">\n${body.trim()}\n</skill>`;
		});
		// The skill bodies go into context as their own (collapsed) message, so
		// the user's prompt is displayed exactly as typed.
		await pi.sendMessage(
			{
				customType: "skill-load",
				content: `Skills referenced by the next user message; follow their instructions:\n\n${blocks.join("\n\n")}`,
				display: true,
				details: { names: seen },
			},
			{ triggerTurn: false },
		);
		rewritten = text; // unchanged
		return { action: "transform", text: rewritten };
	});

	pi.registerMessageRenderer("skill-load", (message, options, theme) => {
		const names = ((message.details as { names?: string[] })?.names ?? []).join(", ");
		let out = theme.fg("accent", "📚 ") + theme.fg("dim", `loaded skills: ${names}`);
		if (options.expanded) out += "\n" + theme.fg("dim", message.content);
		else out += theme.fg("dim", "  · ctrl+o to expand");
		return new Text(out, options.outputPad, 0);
	});
}
