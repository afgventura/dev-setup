#!/usr/bin/env node
/**
 * Turn off cc-my-pi's statusline git-info.
 *
 * git-info runs `git status --porcelain=v1 --untracked-files=all` and `git diff --shortstat
 * HEAD` after every tool call, in every pi process. On the cmx VM an onboarding run keeps
 * ~45 pi processes (sessions and their subagents) in one large checkout, so a `git status`
 * holds `.git/index.lock` nearly all the time, and every index write (`git reset`, `git
 * pull`, `git checkout -- <path>`) fails with "index.lock: File exists" (2026-10-06). The
 * branch segment in the footer is not worth that.
 *
 * This replaces the git-info import in cc-my-pi's loader with a no-op module. The
 * statusline then shows no branch or change count; everything else is unchanged.
 *
 * Idempotent, and shape-verified: if the loader is not the version this knows, it reports
 * that instead of guessing. Re-run after `pi update --extensions`, which reinstalls the
 * package and drops the patch. Takes effect for pi processes started after it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir =
	process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.length > 0
		? process.env.PI_CODING_AGENT_DIR
		: join(homedir(), ".pi", "agent");
const target = join(agentDir, "npm", "node_modules", "cc-my-pi", "extensions", "index.ts");

const ORIGINAL = 'import("./statusline/git-info/index.js"),';
const PATCHED =
	"Promise.resolve({ default: () => {} }), // dev-setup: git-info off (cc-my-pi-no-git-poll.mjs)";

let source;
try {
	source = readFileSync(target, "utf-8");
} catch {
	console.log(`   cc-my-pi-no-git-poll: not applied (no ${target})`);
	process.exit(0);
}

if (source.includes(PATCHED)) {
	console.log("   cc-my-pi-no-git-poll: already applied");
	process.exit(0);
}

const count = source.split(ORIGINAL).length - 1;
if (count !== 1) {
	console.log(
		`   cc-my-pi-no-git-poll: not applied (expected 1 git-info import in ${target}, found ${count}) — re-port it`,
	);
	process.exit(1);
}

writeFileSync(target, source.replace(ORIGINAL, PATCHED));
console.log("   cc-my-pi-no-git-poll: applied (git-info statusline off)");
