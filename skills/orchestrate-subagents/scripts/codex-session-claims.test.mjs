import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(new URL("../../../../", import.meta.url).pathname);
const SCRIPT = join(ROOT, ".agents/skills/orchestrate-subagents/scripts/codex-session.sh");

function run(args, env) {
  const result = spawnSync(SCRIPT, args, { cwd: ROOT, encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("claims reports liveness and --fix clears only dead claims", () => {
  const fixture = mkdtempSync(join(tmpdir(), "codex-session-claims-"));
  const bin = join(fixture, "bin");
  const updates = join(fixture, "updates");
  mkdirSync(bin, { recursive: true });
  writeFileSync(updates, "");
  writeFileSync(
    join(bin, "tmux"),
    "#!/bin/sh\nif [ \"$1\" = list-sessions ]; then printf '%s\\n' codex-wt-rwb; fi\n",
  );
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = list ] && [ "$5" = --porcelain ]; then
  printf 'worktree %s\\n' '${ROOT}'
  printf 'worktree %s\\n' '${fixture}/wt-dead'
  exit 0
fi
exec "$REAL_GIT" "$@"
`,
  );
  writeFileSync(
    join(bin, "fleet-mcp-call"),
    `#!/bin/sh
tool="$2"
args="$3"
if [ "$tool" = pulse_list_tickets ]; then
  case "$args" in
    *'"stats":true'*) printf '%s\\n' '{"total_tickets":4}' ;;
    *) printf '%s\\n' '{"data":[
      {"id":"ticket-live","custom_fields":{"worked_by":"codex-wt-rwb-brief-test-2099-01-01"}},
      {"id":"ticket-old","custom_fields":{"worked_by":"codex-wt-rwb-brief-old-2026-08-01"}},
      {"id":"ticket-dead","custom_fields":{"worked_by":"wt-dead"}},
      {"id":"ticket-unknown","custom_fields":{"worked_by":"mystery"}}
    ]}' ;;
  esac
elif [ "$tool" = pulse_update_ticket ]; then
  printf '%s\\n' "$args" >> '${updates}'
  printf '%s\\n' '{}'
else
  exit 1
fi
`,
  );
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "fleet-mcp-call"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PULSE_MCP_CALL: "fleet-mcp-call",
    REAL_GIT: process.env.GIT_REAL ?? "/usr/bin/git",
  };

  try {
    let result = run(["claims"], env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /codex-wt-rwb-brief-test-2099-01-01\t1\tLIVE\tcodex-wt-rwb/u);
    assert.match(result.output, /wt-dead\t1\tDEAD\tcodex-wt-dead/u);
    assert.match(result.output, /mystery\t1\tUNPARSEABLE\t-/u);
    assert.equal(readFileSync(updates, "utf8"), "", "read-only mode must not update Pulse");

    result = run(["claims", "--stale", "4"], env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /STALE\tcodex-wt-rwb-brief-old-2026-08-01\t1\t/u);
    assert.doesNotMatch(result.output, /STALE\tcodex-wt-rwb-brief-test-2099-01-01/u);
    assert.equal(readFileSync(updates, "utf8"), "", "stale mode must not update Pulse");

    result = run(["claims", "--stale", "4", "--fix"], env);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /report-only and cannot be combined with --fix/u);

    result = run(["claims", "--fix"], env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /CLEARED\twt-dead\tticket-dead/u);
    assert.doesNotMatch(result.output, /ticket-live|ticket-unknown/u);
    assert.match(readFileSync(updates, "utf8"), /"ticket_id":"ticket-dead"/u);
    assert.doesNotMatch(readFileSync(updates, "utf8"), /ticket-live|ticket-unknown/u);
  } finally {
    // The fixture is isolated under the OS temp directory; no repository state is touched.
  }
});
