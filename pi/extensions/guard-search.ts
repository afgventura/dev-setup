/**
 * Refuse the slow searches and local dev servers in pi's bash tool — same
 * rules as the Claude Code / Codex hook in claude/guard-search.sh. `grep -r` and a directory-walking `find`
 * read every file under the path (node_modules, every worktree); rg and fd
 * honour .gitignore and finish in well under a second.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RECURSIVE_GREP = /(^|[;&|(]|\s)grep(\s+[^|;&\s]+)*\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--(dereference-)?recursive)(\s|$)/;
const FIND = /(^|[;&|(]|\s)find\s+[^|;&]*/;
const SHALLOW_FIND = /(^|[;&|(]|\s)find\s+[^|;&]*-maxdepth\s+[012](\s|$)/;
// Local Vite dev servers are disabled on this machine (see claude/guard-search.sh
// for the reasoning; tmux/vite-watchdog.sh kills whatever still slips through).
const DEV_SERVER =
	/HALOAI_ALLOW_VITE_DEV|(^|[;&|(]|\s)(npx\s+|pnpm\s+(exec\s+)?|bunx\s+|bun\s+x\s+)?vite(\s+(dev|serve|--host|--port|--open)|\s*$|\s*[;&|])|(^|[;&|(]|\s)pnpm(\s+(-F|--filter)\s+\S+)?\s+(run\s+)?dev(\s|$)/;
const DEV_SERVER_ALLOWED_CALLER = /scripts\/generate-routes\.sh|wifi-e2e\/scripts\/dev-server\.sh/;

// A recursive rm aimed at /, the home folder, or a folder directly under it
// (~/.config, ~/.pi, ~/Workspace). 2026-10-06: an onboarding subagent ran
// `rm -rf /home/gery/.config` and logged out gh, gcloud, and gws on the VM.
const HOME_ROOT = String.raw`(~|\$\{?HOME\}?|/(home|Users)/[^/\s]+)`;
const PROTECTED_TARGET = new RegExp(
	String.raw`^(/\*?|${HOME_ROOT}/?\*?|${HOME_ROOT}/[^/\s]+/?\*?)$`,
);

export function homeRmReason(command: string): string | undefined {
	const code = command
		.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g, "")
		.replace(/['"]/g, "");
	for (const segment of code.split(/&&|\|\||[;&|\n()]/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		while (words[0] === "sudo" || words[0] === "command" || /^\w+=/.test(words[0] ?? "")) words.shift();
		if (words[0] !== "rm") continue;
		const args = words.slice(1);
		const recursive = args.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === "--recursive");
		if (!recursive) continue;
		const target = args.find((w) => !w.startsWith("-") && PROTECTED_TARGET.test(w));
		if (target) {
			return `blocked: recursive rm on ${target} would delete the home folder or a whole folder under it (credentials, sessions, checkouts). Delete only files inside your own run folder, or write to a new folder instead.`;
		}
	}
	return undefined;
}

export function slowSearchReason(command: string): string | undefined {
	// only the code is inspected: heredoc bodies and quoted strings are dropped,
	// so a literal "find" in a commit message or a file being written is fine
	const bare = command
		.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g, "")
		.replace(/'[^']*'|"[^"]*"/g, "");
	if (RECURSIVE_GREP.test(bare)) {
		return "blocked: recursive grep walks node_modules and every worktree. Use rg (respects .gitignore): rg -n 'pattern' path — or the grep tool.";
	}
	if (FIND.test(bare) && !SHALLOW_FIND.test(bare)) {
		return "blocked: find walks node_modules and every worktree. Use fd (respects .gitignore): fd 'name' path — or the find tool. (find with -maxdepth 0-2 is allowed.)";
	}
	if (DEV_SERVER.test(bare) && !DEV_SERVER_ALLOWED_CALLER.test(bare)) {
		return "blocked: local dev servers are disabled on this machine (device-hygiene). Validate on https://staging.haloai.co.id or production via Chrome MCP; for a build use `vite build`. HALOAI_ALLOW_VITE_DEV is reserved for scripts/generate-routes.sh and apps/wifi-e2e/scripts/dev-server.sh — a server started any other way is killed by the watchdog.";
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown })?.command ?? "");
		const reason = homeRmReason(command) ?? slowSearchReason(command);
		if (reason) return { block: true, reason };
	});
}
