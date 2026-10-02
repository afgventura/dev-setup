/**
 * GitHub issue session title.
 *
 * When the first prompt of a session contains a GitHub issue (or pull request)
 * link, name the session after that issue's title — so the footer, terminal
 * title and session picker all show the ticket instead of an unnamed session.
 *
 * This listens on `input`, not `before_agent_start`, on purpose. `input` runs
 * first and is awaited, so by the time tmux-window-name's `before_agent_start`
 * handler asks `pi.getSessionName()` the issue title is already there: it takes
 * its "restore the existing name" branch, skips the LLM naming call, and names
 * the tmux tab from the same title.
 *
 * The title is only applied when the session is still unnamed and the branch
 * has no user message yet (the literal first prompt). Resumed, `--name`d and
 * subagent sessions keep their own name.
 *
 * Set PI_GITHUB_ISSUE_TITLE_DISABLED=1 to turn it off.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DISABLE_ENV_VAR = "PI_GITHUB_ISSUE_TITLE_DISABLED";
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

// A bare `github.com/o/r/issues/1` is as common in a pasted prompt as the full
// URL, so the scheme is optional. Trailing path/query/fragment is ignored.
const ISSUE_LINK =
	/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/i;

const NAME_MAX_CHARS = 120;
const FETCH_TIMEOUT_MS = 8_000;

type IssueRef = {
	owner: string;
	repo: string;
	kind: "issues" | "pull";
	number: string;
	url: string;
};

/** First GitHub issue or pull-request link in the prompt, if any. */
export function parseIssueRef(text: string): IssueRef | undefined {
	const match = text.match(ISSUE_LINK);
	if (!match) return undefined;

	const [, owner, repo, kind, number] = match;
	if (!owner || !repo || !kind || !number) return undefined;

	const canonicalKind = kind.toLowerCase() === "pull" ? "pull" : "issues";
	return {
		owner,
		repo,
		kind: canonicalKind,
		number,
		url: `https://github.com/${owner}/${repo}/${canonicalKind}/${number}`,
	};
}

/**
 * A session name lands verbatim in the terminal title (`pi - <name> - <cwd>`),
 * the footer and the session picker, so flatten it to one bounded line.
 */
export function toSessionName(title: string): string | undefined {
	const cleaned = title.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	if (cleaned.length <= NAME_MAX_CHARS) return cleaned;
	return `${cleaned.slice(0, NAME_MAX_CHARS - 1).trimEnd()}…`;
}

/** True while the branch has not recorded a user message yet (pre-first-prompt). */
function isFirstPrompt(ctx: ExtensionContext): boolean {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "user") return false;
	}
	return true;
}

async function fetchIssueTitle(pi: ExtensionAPI, ref: IssueRef): Promise<string | undefined> {
	// `gh` first: it uses the user's credentials, so it also resolves private
	// issues. It exits non-zero (rather than throwing) when it is missing or
	// unauthenticated, which is what makes the API fallback reachable.
	const subcommand = ref.kind === "pull" ? "pr" : "issue";
	try {
		const viaCli = await pi.exec("gh", [subcommand, "view", ref.url, "--json", "title", "--jq", ".title"], {
			timeout: FETCH_TIMEOUT_MS,
		});
		const cliTitle = viaCli.code === 0 ? viaCli.stdout.trim() : "";
		if (cliTitle) return cliTitle;
	} catch {
		// fall through to the unauthenticated API
	}

	return fetchIssueTitleViaApi(ref);
}

async function fetchIssueTitleViaApi(ref: IssueRef): Promise<string | undefined> {
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": "pi-github-issue-session-title",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			signal: controller.signal,
		});
		if (!response.ok) return undefined;

		const body: unknown = await response.json();
		const title = (body as { title?: unknown }).title;
		return typeof title === "string" ? title.trim() || undefined : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export default function githubIssueSessionTitle(pi: ExtensionAPI) {
	if (TRUE_VALUES.has((process.env[DISABLE_ENV_VAR] ?? "").trim().toLowerCase())) {
		return;
	}

	let inFlight = false;

	pi.on("input", async (event, ctx) => {
		// Steering and follow-ups are not a fresh prompt.
		if (inFlight || event.streamingBehavior) return;
		// A named session (resumed, `--name`, /rename, or a subagent child) owns
		// its name; never clobber it. Checked before the fetch so the prompt is
		// not delayed for nothing.
		if (pi.getSessionName()) return;
		if (!isFirstPrompt(ctx)) return;

		const ref = parseIssueRef(event.text);
		if (!ref) return;

		inFlight = true;
		try {
			const title = await fetchIssueTitle(pi, ref);
			const name = title ? toSessionName(title) : undefined;
			// The fetch is slow enough that something else can name the session
			// meanwhile — a manual /name, or another extension. First writer wins.
			if (!name || pi.getSessionName()) return;

			pi.setSessionName(name);
			if (ctx.hasUI) {
				const kind = ref.kind === "pull" ? "PR" : "issue";
				ctx.ui.notify(`Session named from ${kind} #${ref.number}: ${name}`, "info");
			}
		} finally {
			inFlight = false;
		}
	});
}
