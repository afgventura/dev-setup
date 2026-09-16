import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(new URL("../../../../", import.meta.url).pathname);
const SCRIPT = join(ROOT, ".agents/skills/orchestrate-subagents/scripts/codex-session.sh");

function run(script, args, env) {
  const result = spawnSync(script, args, { cwd: ROOT, encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout.trim();
}

function writeLedger(path, { rootCause = "", evidence = "" } = {}) {
  writeFileSync(
    path,
    [
      "| Ticket | Client | Symptom | Subagent | Verdict | Pulse status | Next action | Evidence | Area | Root cause |",
      "|---|---|---|---|---|---|---|---|---|---|",
      `| \`ticket-closeout-fields\` | Fixture | test | fixture | shipped | Todo | none | ${evidence} | platform | ${rootCause} |`,
      "",
    ].join("\n"),
  );
}

test("closeout ticket fields refuse missing values and warn when definitions are absent", () => {
  const fixture = mkdtempSync(join(tmpdir(), "codex-closeout-fields-"));
  const home = join(fixture, "home");
  const bin = join(fixture, "bin");
  const ledger = join(fixture, "pulse-ledger.md");
  const session = "codex-closeout-fields-fixture";
  mkdirSync(join(home, ".orchestrate-subagents", "closeouts"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\n[ \"$1\" = has-session ]\n");
  chmodSync(join(bin, "tmux"), 0o755);
  writeFileSync(
    join(home, ".orchestrate-subagents", `${session}.env`),
    `repo=${ROOT}\nbranch=test\nowned=0\nowner=codex-session-closeout-fields-test\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    ORCHESTRATOR_ID: "codex-session-closeout-fields-test",
    PATH: `${bin}:${process.env.PATH}`,
    PULSE_LEDGER_PATH: ledger,
  };

  try {
    writeLedger(ledger, { rootCause: "code-defect" });
    let result = run(SCRIPT, ["closeout", session, "--tickets", "ticket-closeout-fields", "--no-ship", "missing"], env);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /ticket 'ticket-closeout-fields' is missing evidence/u);

    writeLedger(ledger, { rootCause: "code-defect", evidence: "commit abc1234; 1/1 fixture" });
    result = run(SCRIPT, ["closeout", session, "--tickets", "ticket-closeout-fields", "--no-ship", "complete"], env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /recorded closeout/u);
    assert.match(readFileSync(join(home, ".orchestrate-subagents/closeouts", `${session}.env`), "utf8"), /mode=no-ship/u);

    writeFileSync(ledger, "| Ticket | Pulse status |\n|---|---|\n| `ticket-closeout-fields` | Todo |\n");
    result = run(SCRIPT, ["closeout", session, "--tickets", "ticket-closeout-fields", "--no-ship", "not provisioned"], env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /WARNING: skipped ticket root_cause\/evidence check; field definitions are absent/u);
  } finally {
    // The fixture is isolated under the OS temp directory; no repository state is touched.
  }
});

test("verify-sha checks every cited path and fails when the commit is missing or the path is absent", () => {
  const fixture = mkdtempSync(join(tmpdir(), "codex-verify-sha-"));
  const repo = join(fixture, "repo");
  const script = join(repo, ".agents/skills/orchestrate-subagents/scripts/codex-session.sh");
  mkdirSync(join(repo, ".agents/skills/orchestrate-subagents/scripts"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.email", "fixture@example.com"]);
  runGit(repo, ["config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "src/outbound.ts"), "export const outbound = true;\n");
  runGit(repo, ["add", "src/outbound.ts"]);
  runGit(repo, ["commit", "-m", "fixture outbound change", "--quiet"]);
  const sha = runGit(repo, ["rev-parse", "HEAD"]);

  const env = { ...process.env, HOME: join(fixture, "home") };
  let result = run(script, ["verify-sha", "--help"], env);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /inbound and outbound duplicate delivery are different paths/u);
  assert.match(result.output, /1650c3f3cc[\s\S]*292bf1478c/u);

  result = run(script, ["verify-sha", "ticket-1", sha.slice(0, 10), "--path", "src/outbound.ts:42"], env);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /CHANGED_FILES:[\s\S]*src\/outbound\.ts/u);
  assert.match(result.output, /PATH path=src\/outbound\.ts:42 normalized=src\/outbound\.ts touched=yes/u);
  assert.match(result.output, /PASS ticket=ticket-1/u);

  result = run(script, ["verify-sha", "ticket-1", sha, "--path", "src/inbound.ts"], env);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /CHANGED_FILES:[\s\S]*src\/outbound\.ts/u);
  assert.match(result.output, /touched=no/u);
  assert.match(result.output, /FAIL ticket=ticket-1/u);

  result = run(script, ["verify-sha", "ticket-1", "deadbeef", "--path", "src/outbound.ts"], env);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /FAIL ticket=ticket-1 sha=deadbeef/u);
  assert.match(result.output, /CHANGED_FILES: unavailable \(commit does not exist/u);

});
