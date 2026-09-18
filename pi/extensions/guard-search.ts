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
		const reason = slowSearchReason(command);
		if (reason) return { block: true, reason };
	});
}
