#!/usr/bin/env bash
# Drive persistent Codex CLI sessions in tmux, one per git worktree.
#
# RUNTIME: a git worktree of THIS repository, created per subagent under
# <workspace>/haloai-wt/wt-<slug> on its own branch. Always use `acquire`.
#
# The sibling clone pool (haloai-2..8) is DEPRECATED and is being retired by the
# director. Never assign a new session to one. `claim` and CODEX_REPO_POOL are
# kept only so work already running in a clone can be finished; when that task
# lands, the next one goes to a worktree.
#
# A worktree is claimed by creating a tmux session named after it. tmux refuses
# duplicate session names, so the session IS the mutex: two claims of the same
# directory cannot both succeed, even from different terminals or agents.
#
# A worktree this script created is OWNED by its session. Releasing that session
# removes the worktree, because an abandoned worktree is invisible state: it
# holds a branch, a full node_modules, and an unreviewed diff nobody sweeps.
#
# Subcommands:
#   acquire [slug] [opts]     Create a worktree + branch and start Codex in it
#   claim <dir> [--allow-dirty]
#                             DEPRECATED. Claim an existing clone/worktree (not
#                             owned). Only to finish work already in flight.
#   list                      Show every session with its OWNER, plus free worktrees
#   mine                      Only the sessions you acquired, busy/idle — the sweep
#   send <session> <file>     Hand Codex a brief file, print that turn's output
#   ask <session> <text>      Send a one-line message, print that turn's output
#   dispatch <session> <file> Same as send, but return immediately
#   wait <session>            Block until the current turn ends, then print the tail
#   read <session> [n]        Print the last n transcript lines (default 120)
#   status <session>          Print "busy" or "idle"
#   repo <session>            Print the worktree path this session works in
#   closeout <session> ...    Record the three closeout steps, or a no-ship reason
#   stop <session> [opts]     Release the session AND remove its owned worktree
#   stop-all [opts]           Release every session this script owns
#   doctor                    Fleet health: drift, dirt, stashes, litter, unfinalized
#   claims [--fix] [--stale <hours>]
#                             Report scoped Pulse claims; clear only dead claims
#   sweep [--remove]          Remove only clean, fully-pushed, session-free worktrees
#   boundary [<sha>...]        Print the live GKE image, deploy boundary, and ancestry
#   fences                    Print the standing-fences reference
#   gate                      Print the five-line Resolve gate
#   verify-sha <ticket-id> <sha> --path <file>[:<line>] [--path ...] [--in-image]
#                              Verify a ticket's cited path against a commit diff
#   sync-main [--force]       Put the director's repo back on origin/main. Runs
#                             automatically on every `acquire`; refuses on tracked
#                             dirt unless --force.
#
# acquire options:
#   --branch <name>   branch to create (default: agent/<slug>)
#   --base <ref>      base to branch from (default: origin/main, fetched first)
#   --install         run `pnpm install` in the new worktree (default: skip it;
#                     a full install costs minutes and 4.5 GB, and most sessions
#                     never run a test — let the session install if it needs to)
#   --no-install      explicit form of the default
#   --reuse           attach to an existing worktree of the same slug
#
# stop / stop-all options:
#   --keep-worktree   release the session but leave the worktree on disk
#   --force           remove the worktree even if it is dirty or has unpushed commits
#   --delete-branch   also delete the branch after removing the worktree
#
# closeout options:
#   --finalize-sha <sha> --deployed <mechanism> --validated <evidence>
#                     record the three shipping steps; the sha must be on origin/main
#   --no-ship <reason> record why this session has no change to deploy or validate
#   --tickets <id[,id...]> require root_cause and evidence on each ticket row
#
# Env:
#   ORCHESTRATOR_ID       who you are. Export it ONCE at the start of a manager
#                         session, before any acquire. Every acquire stamps it;
#                         dispatch/send/ask/stop refuse a session stamped by
#                         somebody else unless you pass --adopt. Unset means
#                         "unattributed", which collides with every other
#                         unattributed manager — so set it.
#   HALOAI_WORKTREE_ROOT  where worktrees live (default: <workspace>/haloai-wt)
#   CODEX_REPO_POOL       legacy space-separated clone paths for `list`/`claim`
#   CODEX_WAIT_SECONDS    max wait per turn (default: 1800)
#   CODEX_EXTRA_ARGS      extra codex flags, e.g. "--sandbox workspace-write"
#
# Sandbox and approval policy are inherited from ~/.codex/config.toml rather than
# forced here. Passing --sandbox workspace-write makes .git read-only, which
# blocks fetch/reset/commit inside the session; under that policy the session
# cannot run /finalize-change, so check the policy before briefing.

set -euo pipefail

MAX_WAIT="${CODEX_WAIT_SECONDS:-1800}"
BUSY_MARKER="esc to interrupt"
SCROLLBACK=200000
PREFIX="codex-"
STATE_DIR="${HOME}/.orchestrate-subagents"
CLOSEOUT_DIR="${STATE_DIR}/closeouts"
WORKSHEET_DIR="${STATE_DIR}/worksheets"
FETCH_STAMP="${STATE_DIR}/.origin-main-fetched"
# A wave of acquires all fetched origin/main at once and lost the ref lock to the
# other fleet's sessions. The base only needs to be current per wave, not per
# session, so one fetch inside this window serves the whole wave.
FETCH_TTL="${CODEX_FETCH_TTL_SECONDS:-90}"

# WHO acquired a session, as opposed to whether this script created its worktree.
# Several managers and the director drive sessions on the same machine, so
# `owned=1` (the script made the worktree) never meant "mine". Set
# ORCHESTRATOR_ID once per manager session; every acquire stamps it, and every
# turn-taking command refuses a session stamped by somebody else.
ORCHESTRATOR_ID="${ORCHESTRATOR_ID:-}"

owner_id() { echo "${ORCHESTRATOR_ID:-unattributed}"; }

die() {
  echo "codex-session: $*" >&2
  exit 1
}

# The repository this script lives in. Worktrees are created from here, and
# `git worktree remove` must also run from here.
main_repo() {
  local top common
  top=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel) ||
    die "not inside a git repository"
  # If this checkout is itself a worktree, resolve back to the main checkout.
  common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir)
  dirname "$common"
}

worktree_root() {
  if [ -n "${HALOAI_WORKTREE_ROOT:-}" ]; then
    echo "$HALOAI_WORKTREE_ROOT"
  else
    echo "$(dirname "$(main_repo)")/haloai-wt"
  fi
}

session_for() { echo "${PREFIX}$(basename "$1")"; }

session_exists() { tmux has-session -t "$1" 2>/dev/null; }

require_session() {
  session_exists "$1" || die "no session '$1'. Run: $0 list"
}

# The orchestrator drops the brief and its follow-ups into the worktree itself,
# so they show up as untracked files forever and made every `stop` refuse. They
# are our own scaffolding, not the worker's unsaved work: ignore them, and only
# them, when deciding whether a tree holds something worth keeping.
ORCHESTRATOR_SCAFFOLD='^\?\? (brief|followup[0-9]*|config-check|split|evidence|checklist-[0-9a-f-]+)\.md$'

is_dirty() {
  [ -n "$(git -C "$1" status --porcelain 2>/dev/null | grep -Ev "$ORCHESTRATOR_SCAFFOLD")" ]
}

state_file() { echo "${STATE_DIR}/$1.env"; }

closeout_file() { echo "${CLOSEOUT_DIR}/$1.env"; }

# One fetch per wave, not one per acquire. Acquiring twelve sessions used to fire
# twelve `git fetch origin main` at the same shared `.git`, and the losers of the
# `refs/remotes/origin/main` lock race failed their fetch and silently branched
# from a stale local ref. Returns 0 when origin/main is current enough to branch
# from; non-zero only when a fetch was genuinely needed and genuinely failed.
fetch_origin_main() {
  local repo="$1" age now stamped
  mkdir -p "$STATE_DIR"
  if [ -f "$FETCH_STAMP" ]; then
    now=$(date +%s)
    stamped=$(cat "$FETCH_STAMP" 2>/dev/null || echo 0)
    age=$((now - stamped))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$FETCH_TTL" ]; then
      return 0
    fi
  fi
  git -C "$repo" fetch origin main --quiet || return 1
  date +%s >"$FETCH_STAMP"
  return 0
}

# `.artifacts/` is gitignored and `stop` deletes the worktree, so a session's
# worksheet — the only durable record of what it found — dies with the tree
# unless it is copied out first. Archive runs BEFORE any removal and copies only
# files git does not track, so it can never pick up the thousand-odd tracked
# `.artifacts` files that inherit the worktree's checkout mtime (two earlier
# hand-rolled rescues did exactly that, once 367 files and once 1,230).
# A failed archive is a refusal to remove, not a warning: the tree is the copy.
archive_worksheets() {
  local session="$1" dir="$2" dest count=0 rel
  [ -d "$dir/.artifacts" ] || return 0
  dest="${WORKSHEET_DIR}/${session}-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dest" || return 1

  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in */.DS_Store | .DS_Store) continue ;; esac
    # A dangling symlink is listed by ls-files but has no content to save (this
    # repo holds several pointing into ~/Downloads). Skipping one must not wedge
    # a teardown; failing to copy a file that really exists must.
    if [ ! -f "$dir/$rel" ]; then
      echo "SKIPPED (not a readable regular file) $rel" >>"$dest/MANIFEST.txt"
      continue
    fi
    mkdir -p "$dest/$(dirname "$rel")" || return 1
    cp -p "$dir/$rel" "$dest/$rel" || return 1
    echo "$rel" >>"$dest/MANIFEST.txt"
    count=$((count + 1))
  # Two sources, because a session's findings arrive as both:
  #  - `ls-files --others`: untracked files. No --exclude-standard, since
  #    `.artifacts/` is gitignored and honouring the ignore rules would skip
  #    precisely the files worth saving.
  #  - `diff --name-only HEAD`: tracked `.artifacts` files the session EDITED.
  #    Found on wt-nq-b7, whose whole output was an edit to a committed
  #    investigation note — invisible to --others and lost by a plain teardown.
  done < <({
    git -C "$dir" ls-files --others -- .artifacts 2>/dev/null || true
    git -C "$dir" diff --name-only HEAD -- .artifacts 2>/dev/null || true
  } | sort -u)

  if [ "$count" -eq 0 ]; then
    rmdir "$dest" 2>/dev/null || true
    return 0
  fi

  # The manifest must list exactly what landed, or the archive is not evidence.
  local landed
  landed=$(find "$dest" -type f ! -name MANIFEST.txt | wc -l | tr -d ' ')
  if [ "$landed" -ne "$count" ]; then
    echo "codex-session: archive incomplete for '$session': expected $count file(s), found $landed in $dest" >&2
    return 1
  fi
  echo "archived $count worksheet file(s) -> $dest"
  return 0
}

write_state() {
  local session="$1" repo="$2" branch="$3" owned="$4"
  mkdir -p "$STATE_DIR"
  cat >"$(state_file "$session")" <<EOF
repo=$repo
branch=$branch
owned=$owned
owner=$(owner_id)
acquired_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

session_owner() { read_state "$1" owner 2>/dev/null || echo "unattributed"; }

closeout_value() { # closeout_value <session> <key>
  local f
  f=$(closeout_file "$1")
  [ -f "$f" ] || return 1
  grep -E "^$2=" "$f" | head -1 | cut -d= -f2-
}

# Values are operator attestations, but blank and stock placeholders are not
# evidence. The finalize SHA gets an additional repository reachability check.
is_real_closeout_value() {
  local value="$1" compact normalized
  compact=$(printf '%s' "$value" | tr -d '[:space:]')
  [ -n "$compact" ] || return 1
  normalized=$(printf '%s' "$compact" | tr '[:upper:]' '[:lower:]')
  case "$normalized" in
    n/a|na|todo|-|pending|tbd|unknown|none|notapplicable) return 1 ;;
  esac
  return 0
}

closeout_missing() { # closeout_missing <session>
  local session="$1" mode missing="" value
  [ -f "$(closeout_file "$session")" ] || {
    echo "finalize, deploy, validate"
    return 0
  }
  mode=$(closeout_value "$session" mode 2>/dev/null || true)
  if [ "$mode" = "no-ship" ]; then
    value=$(closeout_value "$session" reason 2>/dev/null || true)
    is_real_closeout_value "$value" || echo "no-ship reason"
    return 0
  fi
  for value in finalize_sha deployed validated; do
    local recorded
    recorded=$(closeout_value "$session" "$value" 2>/dev/null || true)
    is_real_closeout_value "$recorded" || {
      case "$value" in
        finalize_sha) missing="${missing}${missing:+, }finalize" ;;
        deployed) missing="${missing}${missing:+, }deploy" ;;
        validated) missing="${missing}${missing:+, }validate" ;;
      esac
    }
  done
  echo "${missing:-none}"
}

closeout_complete() { # closeout_complete <session>
  local session="$1" mode sha deployed validated reason
  [ -f "$(closeout_file "$session")" ] || return 1
  mode=$(closeout_value "$session" mode 2>/dev/null || true)
  if [ "$mode" = "no-ship" ]; then
    reason=$(closeout_value "$session" reason 2>/dev/null || true)
    is_real_closeout_value "$reason"
    return $?
  fi
  [ "$mode" = "ship" ] || return 1
  sha=$(closeout_value "$session" finalize_sha 2>/dev/null || true)
  deployed=$(closeout_value "$session" deployed 2>/dev/null || true)
  validated=$(closeout_value "$session" validated 2>/dev/null || true)
  is_real_closeout_value "$sha" &&
    is_real_closeout_value "$deployed" &&
    is_real_closeout_value "$validated"
}

closeout_summary() { # closeout_summary <session>
  local session="$1" mode reason missing
  if [ ! -f "$(closeout_file "$session")" ]; then
    echo "missing: finalize, deploy, validate"
    return 0
  fi
  mode=$(closeout_value "$session" mode 2>/dev/null || true)
  if [ "$mode" = "no-ship" ]; then
    reason=$(closeout_value "$session" reason 2>/dev/null || true)
    if is_real_closeout_value "$reason"; then
      echo "no-ship"
    else
      echo "missing: no-ship reason"
    fi
    return 0
  fi
  missing=$(closeout_missing "$session")
  [ "$missing" = "none" ] && echo "complete" || echo "missing: $missing"
}

clear_closeout() { rm -f "$(closeout_file "$1")"; }

verify_finalize_sha() { # verify_finalize_sha <repo> <sha>; prints the full commit SHA
  local repo="$1" sha="$2" resolved
  case "$sha" in
    ''|*[!0-9a-fA-F]*) die "--finalize-sha must be a hexadecimal commit SHA" ;;
  esac
  git -C "$repo" fetch origin main --quiet ||
    die "could not refresh origin/main; cannot verify --finalize-sha"
  if ! resolved=$(git -C "$repo" rev-parse --verify "$sha^{commit}" 2>/dev/null); then
    die "--finalize-sha '$sha' is not a commit known to this repository"
  fi
  git -C "$repo" rev-parse --verify "origin/main^{commit}" >/dev/null 2>&1 ||
    die "origin/main is unavailable; cannot verify --finalize-sha"
  git -C "$repo" merge-base --is-ancestor "$resolved" origin/main ||
    die "--finalize-sha '$sha' is not on origin/main; finish /finalize-change first"
  echo "$resolved"
}

write_closeout() { # write_closeout <session> <mode> <finalize-sha> <deployed> <validated> <reason>
  local session="$1" mode="$2" finalize_sha="$3" deployed="$4" validated="$5" reason="$6"
  local file tmp
  file=$(closeout_file "$session")
  tmp="${file}.tmp.$$"
  mkdir -p "$CLOSEOUT_DIR"
  {
    printf 'session=%s\n' "$session"
    printf 'mode=%s\n' "$mode"
    printf 'finalize_sha=%s\n' "$finalize_sha"
    printf 'deployed=%s\n' "$deployed"
    printf 'validated=%s\n' "$validated"
    printf 'reason=%s\n' "$reason"
    printf 'recorded_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'recorded_by=%s\n' "$(owner_id)"
  } >"$tmp" || {
    rm -f "$tmp"
    die "could not write closeout record for '$session'"
  }
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

closeout_gate() { # closeout_gate <session> <force>; returns non-zero unless complete or forced
  local session="$1" force="$2" missing
  closeout_complete "$session" && return 0
  missing=$(closeout_missing "$session")
  if [ "$force" -eq 1 ]; then
    echo "WARNING: closeout bypassed for '$session' with --force; missing: $missing." >&2
    echo "  The session is being released without the closeout evidence; do the missing step(s), not --force." >&2
    return 0
  fi
  echo "NOT removed: '$session' has no complete closeout record; missing: $missing." >&2
  echo "  Do the missing step(s), then record them with '$0 closeout $session ...'; do the step, not --force." >&2
  return 1
}

# Refuse to drive a session somebody else acquired. Reading is always allowed;
# only the commands that take a turn, or release the session, are gated.
#
# Two managers plus the director share this machine. Dispatching into another
# manager's session collides two briefs in one worktree and produces a diff
# nobody can reconcile; merging its PR takes credit for work you did not review.
# Both have happened. `--adopt` is the deliberate hand-over, and it restamps the
# session so the next sweep tells the truth.
require_owner() { # require_owner <session> <verb> [--adopt]
  local session="$1" verb="$2" adopt="${3:-}" owner me
  owner=$(session_owner "$session")
  me=$(owner_id)
  [ "$owner" = "$me" ] && return 0
  if [ "$adopt" = "--adopt" ]; then
    write_state "$session" "$(read_state "$session" repo 2>/dev/null || echo unknown)" \
      "$(read_state "$session" branch 2>/dev/null || echo unknown)" \
      "$(read_state "$session" owned 2>/dev/null || echo 0)"
    echo "codex-session: adopted '$session' from '$owner'" >&2
    return 0
  fi
  die "refusing to $verb '$session': acquired by '$owner', you are '$me'.
  Read it freely ($0 read $session). To take it over, ask the director, then
  re-run with --adopt. Do not merge or close a deliverable you do not own."
}

read_state() { # read_state <session> <key>
  local f
  f=$(state_file "$1")
  [ -f "$f" ] || return 1
  grep -E "^$2=" "$f" | head -1 | cut -d= -f2-
}

# Non-blank transcript lines. tmux pads the visible pane to its full height with
# blank rows; counting those would inflate turn offsets and swallow output.
transcript() {
  tmux capture-pane -p -S -"$SCROLLBACK" -t "$1" | grep . || true
}

line_count() { transcript "$1" | wc -l | tr -d '[:space:]'; }

is_busy() { tmux capture-pane -p -t "$1" | grep -qF "$BUSY_MARKER"; }

# The busy footer briefly disappears while Codex renders a completed step, so a
# single absent reading is not proof the turn ended. Require the marker to stay
# absent AND the transcript to stop growing across several consecutive polls.
QUIET_POLLS=5

wait_idle() {
  local session="$1" waited=0 quiet=0 last="" now
  sleep 5 # let Codex pick the turn up before trusting any reading
  while :; do
    now=$(line_count "$session")
    if is_busy "$session" || [ "$now" != "$last" ]; then
      quiet=0
    else
      quiet=$((quiet + 1))
      [ "$quiet" -ge "$QUIET_POLLS" ] && break
    fi
    last="$now"
    sleep 3
    waited=$((waited + 3))
    if [ "$waited" -ge "$MAX_WAIT" ]; then
      die "'$session' still busy after ${MAX_WAIT}s. Inspect: $0 read $session"
    fi
  done
}

submit() {
  tmux send-keys -t "$1" -l "$2"
  sleep 1
  tmux send-keys -t "$1" Enter
}

# Atomically claim a directory. Returns non-zero if it is already taken.
try_claim() {
  local dir="$1" session
  session=$(session_for "$dir")
  # `cd` explicitly rather than relying on `-c`: when the tmux server's own cwd
  # is a deleted directory (a worktree removed by `stop`), `-c` fails to chdir
  # and the pane starts in a nonexistent cwd, where codex exits immediately with
  # "Error loading configuration: No such file or directory (os error 2)".
  # The worker must not be able to reach this tmux server. On 2026-09-14 a
  # worker finalizing its own change read this script, then ran a raw
  # `tmux kill-session` on three sibling `codex-wt-*` sessions it decided were
  # "task sessions" to tidy up — the owner guard only protects callers of this
  # script. Unsetting TMUX/TMUX_PANE and pointing TMUX_TMPDIR at an empty
  # directory makes `tmux` inside the pane see no server at all (the dir must
  # exist: tmux 3.7 silently falls back to /tmp otherwise); the manager still
  # drives the session from outside as before.
  local jail="$HOME/.orchestrate-subagents/tmux-jail"
  mkdir -p "$jail"
  tmux new-session -d -s "$session" -x 200 -y 50 -c "$dir" \
    "cd '$dir' || exit 1; exec env -u TMUX -u TMUX_PANE TMUX_TMPDIR='$jail' codex --cd '$dir' ${CODEX_EXTRA_ARGS:-}" 2>/dev/null || return 1
  echo "$session"
}

boot_wait() {
  local session="$1"
  sleep 10
  is_busy "$session" && wait_idle "$session"
  return 0
}

# The env-var names Codex's MCP servers authenticate with, read from its own
# config so this never drifts from what Codex actually needs.
mcp_token_vars() {
  local cfg="${CODEX_HOME:-$HOME/.codex}/config.toml"
  [ -f "$cfg" ] || return 0
  sed -n 's/^[[:space:]]*bearer_token_env_var[[:space:]]*=[[:space:]]*"\([A-Za-z_][A-Za-z0-9_]*\)".*/\1/p' "$cfg" | sort -u
}

# Names of the MCP token variables that are set here but would not reach a
# worker; printed one per line. Empty output means every token is exported.
missing_mcp_token_vars() {
  local var
  for var in $(mcp_token_vars); do
    [ -n "$(eval "printf '%s' \"\${$var:-}\"")" ] || echo "$var"
  done
}

# The pane execs `codex` directly under the tmux SERVER's environment, not a
# login shell, so anything only exported from .zshrc never reaches it. On
# 2026-09-15 every worker in a four-session audit reported the Cloud SQL and
# halo_platform MCPs "unavailable" and skipped all production measurement: the
# server had been started before CLOUDSQL_MCP_TOKEN existed in that file.
# Copy each token that is set in THIS shell into the tmux global environment
# (inherited by every new session; nothing appears on a command line or in ps)
# and warn loudly about the ones that are not set anywhere.
export_mcp_tokens_to_tmux() {
  local var missing
  for var in $(mcp_token_vars); do
    eval "val=\${$var:-}"
    [ -n "$val" ] && tmux set-environment -g "$var" "$val" 2>/dev/null
  done
  missing=$(missing_mcp_token_vars)
  if [ -n "$missing" ]; then
    echo "WARNING: not set in this shell, so the worker's MCP server(s) will fail" >&2
    echo "         to authenticate and it will report them 'unavailable':" >&2
    printf '           %s\n' $missing >&2
    echo "         Export them (they live in ~/.zshrc) and re-run, or brief the" >&2
    echo "         worker that it has no production/MCP access." >&2
  fi
}

preflight() {
  command -v tmux >/dev/null || die "tmux not installed (brew install tmux)"
  command -v codex >/dev/null || die "codex CLI not installed"
  export_mcp_tokens_to_tmux
}

report_claim() {
  local session="$1" dir="$2"
  echo "session=$session"
  echo "repo=$dir"
  echo "branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  echo "attach: tmux attach -t $session"
}

cmd_acquire() {
  # Installing costs minutes and 4.5 GB per worktree, and most sessions never run
  # a test. Default to skipping it; the session installs if and when it needs to.
  local slug="" branch="" base="origin/main" install=0 reuse=0 arg
  local repo root dir session
  while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --branch) branch="${2:?--branch needs a value}"; shift 2 ;;
      --base) base="${2:?--base needs a value}"; shift 2 ;;
      --no-install) install=0; shift ;;
      --install) install=1; shift ;;
      --reuse) reuse=1; shift ;;
      -*) die "unknown option: $arg" ;;
      *) slug="$arg"; shift ;;
    esac
  done
  preflight
  [ -n "$slug" ] || slug="$(date +%m%d-%H%M%S)"
  slug="${slug#wt-}"
  branch="${branch:-agent/$slug}"

  repo=$(main_repo)
  root=$(worktree_root)
  dir="$root/wt-$slug"
  session=$(session_for "$dir")

  # Every task starts here, so this is the natural place to keep the director's
  # checkout current. Advisory only: a refusal (dirt, or an untracked file that
  # is now tracked upstream) must not block acquiring a worktree, which branches
  # from the freshly fetched origin/main regardless of local HEAD.
  cmd_sync_main >&2 || true

  if [ -e "$dir" ]; then
    [ "$reuse" -eq 1 ] || die "$dir already exists. Pick another slug, or pass
     --reuse to attach a session to the existing worktree."
  else
    mkdir -p "$root"
    fetch_origin_main "$repo" ||
      echo "codex-session: warning: fetch failed, branching from local $base" >&2
    git -C "$repo" worktree add -b "$branch" "$dir" "$base" >&2 ||
      die "could not create worktree $dir on branch $branch"
    if [ "$install" -eq 1 ]; then
      echo "codex-session: installing dependencies in $dir (several minutes)" >&2
      (cd "$dir" && pnpm install --frozen-lockfile >&2) ||
        echo "codex-session: warning: pnpm install failed. The session cannot run
     tests or /finalize-change until dependencies are installed." >&2
    else
      echo "codex-session: no pnpm install (default). If this session needs to run
     tests or /finalize-change, it should run 'pnpm install --frozen-lockfile'
     itself. Pass --install to acquire it pre-installed." >&2
    fi
  fi

  session=$(try_claim "$dir") ||
    die "$dir is already claimed by $(session_for "$dir")"
  clear_closeout "$session"
  write_state "$session" "$dir" "$branch" 1
  boot_wait "$session"
  report_claim "$session" "$dir"
  echo "owned_worktree=yes (removed when you run: $0 stop $session)"
}

cmd_claim() {
  local dir="" allow_dirty=0 arg session
  for arg in "$@"; do
    case "$arg" in
      --allow-dirty) allow_dirty=1 ;;
      *) dir="$arg" ;;
    esac
  done
  [ -n "$dir" ] || die "usage: $0 claim <dir> [--allow-dirty]"
  preflight
  # A clone has a .git directory; a git worktree has a .git file pointing at one.
  [ -e "$dir/.git" ] || die "not a git clone or worktree: $dir"
  if [ "$allow_dirty" -eq 0 ] && is_dirty "$dir"; then
    die "$dir has uncommitted work. Use '$0 acquire <slug>' for a fresh worktree,
     or pass --allow-dirty only after confirming with the user that the change
     may be touched."
  fi
  session=$(try_claim "$dir") || die "$dir is already claimed by $(session_for "$dir")"
  clear_closeout "$session"
  write_state "$session" "$dir" "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" 0
  boot_wait "$session"
  report_claim "$session" "$dir"
  echo "owned_worktree=no (stop leaves $dir on disk)"
}

cmd_list() {
  local repo root dir session state owned closeout
  repo=$(main_repo)
  root=$(worktree_root)

  echo "worktrees under $root    (you are '$(owner_id)')"
  printf "%-24s %-20s %-30s %-16s %-34s %s\n" DIR SESSION BRANCH OWNER CLOSEOUT STATE
  while read -r dir; do
    [ -n "$dir" ] || continue
    case "$dir" in "$root"/*) ;; *) continue ;; esac
    session=$(session_for "$dir")
    if session_exists "$session"; then
      state="claimed ($(is_busy "$session" && echo busy || echo idle))"
      owned=$(session_owner "$session")
      [ "$owned" = "$(owner_id)" ] && owned="$owned (you)"
      closeout=$(closeout_summary "$session")
    elif is_dirty "$dir"; then
      state="free but DIRTY ($(git -C "$dir" status --porcelain | wc -l | tr -d ' ') files)"
      owned="-"
      closeout="-"
    else
      state="free"
      owned="-"
      closeout="-"
    fi
    printf "%-24s %-20s %-30s %-16s %-34s %s\n" "$(basename "$dir")" \
      "$(session_exists "$session" && echo "$session" || echo -)" \
      "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" "$owned" "$closeout" "$state"
  done < <(git -C "$repo" worktree list --porcelain | sed -n 's/^worktree //p')

  echo
  echo "OWNER is who acquired the session, not who made the worktree."
  echo "Only drive a row marked (you). Read any row; dispatch/ask/stop needs --adopt."

  if [ -n "${CODEX_REPO_POOL:-}" ]; then
    echo
    echo "legacy clone pool (CODEX_REPO_POOL)"
    printf "%-24s %-20s %-34s %-34s %s\n" DIR SESSION BRANCH CLOSEOUT STATE
    while read -r dir; do
      [ -n "$dir" ] || continue
      session=$(session_for "$dir")
      if session_exists "$session"; then
        state="claimed ($(is_busy "$session" && echo busy || echo idle))"
        closeout=$(closeout_summary "$session")
      elif is_dirty "$dir"; then
        state="free but DIRTY"
        closeout="-"
      else
        state="free"
        closeout="-"
      fi
      printf "%-24s %-20s %-34s %-34s %s\n" "$(basename "$dir")" \
        "$(session_exists "$session" && echo "$session" || echo -)" \
        "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" "$closeout" "$state"
    done < <(tr ' ' '\n' <<<"$CODEX_REPO_POOL" | grep .)
  fi

  echo
  echo "orphan check: worktrees with no session and no owner are yours to remove."
}

# ---------------------------------------------------------------------------
# Pulse claim doctor
#
# `worked_by` is a durable claim, while the tmux session is the liveness signal.
# Keep this command deliberately narrow: it is for the Tribe Support workspace
# census, and --fix may only clear claims whose session/worktree identity is
# provably dead. The MCP bridge is injectable only for isolated tests; operators
# use the guarded fleet-mcp-call client so credentials never enter this script.
# ---------------------------------------------------------------------------

PULSE_CLAIM_WORKSPACE="019951bc-7de0-75df-a3bc-c915e5837fe3"
PULSE_CLAIM_DIVISION="Tribe Support"
PULSE_CLAIM_MCP_CALL="${PULSE_MCP_CALL:-fleet-mcp-call}"
PULSE_CLAIMS_TMP=""

pulse_claim_call() { # pulse_claim_call <tool> <json-args>
  local tool="$1" args="$2" raw normalized
  command -v "$PULSE_CLAIM_MCP_CALL" >/dev/null 2>&1 ||
    die "'$PULSE_CLAIM_MCP_CALL' is required for claims; use the guarded fleet-mcp-call client"
  raw=$("$PULSE_CLAIM_MCP_CALL" halo_platform "$tool" "$args") ||
    die "Pulse MCP call failed: $tool"
  normalized=$(printf '%s' "$raw" | jq -e -c '
    def unwrap:
      if type == "string" then
        try (fromjson | unwrap) catch .
      elif type == "object" and has("result") then
        .result | unwrap
      elif type == "object" and has("structuredContent") then
        .structuredContent | unwrap
      elif type == "object" and (.content | type) == "array" then
        ([.content[] | select(.type == "text") | .text] | join("") | fromjson) | unwrap
      else .
      end;
    unwrap
  ') || die "Pulse MCP call returned an unreadable response: $tool"
  printf '%s\n' "$normalized"
}

pulse_claim_live_sessions() {
  tmux list-sessions -F '#S' 2>/dev/null | grep '^codex-' || true
}

pulse_claim_worktree_names() {
  local dir
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    basename "$dir"
  done < <(git -C "$(main_repo)" worktree list --porcelain | sed -n 's/^worktree //p')
}

pulse_claim_session_for() { # pulse_claim_session_for <claim> <live-file> <worktree-file>
  local claim="$1" live_file="$2" worktree_file="$3" session worktree
  while IFS= read -r session; do
    [ -n "$session" ] || continue
    if [ "$claim" = "$session" ] || [[ "$claim" == "$session-brief-"* ]]; then
      printf 'LIVE\t%s\n' "$session"
      return 0
    fi
  done < "$live_file"

  while IFS= read -r worktree; do
    [ -n "$worktree" ] || continue
    session="$(session_for "$worktree")"
    if [ "$claim" = "$worktree" ] || [ "$claim" = "$session" ] ||
      [[ "$claim" == "$session-brief-"* ]]; then
      if grep -Fxq "$session" "$live_file"; then
        printf 'LIVE\t%s\n' "$session"
      else
        printf 'DEAD\t%s\n' "$session"
      fi
      return 0
    fi
  done < "$worktree_file"

  printf 'UNPARSEABLE\t-\n'
}

pulse_claim_timestamp() { # pulse_claim_timestamp <claim>
  local claim="$1" stamp format epoch utc=0
  if [[ "$claim" =~ ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) ]]; then
    stamp="${BASH_REMATCH[1]}"
    format='%Y-%m-%dT%H:%M:%SZ'
    utc=1
  elif [[ "$claim" =~ ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z) ]]; then
    stamp="${BASH_REMATCH[1]}"
    format='%Y-%m-%dT%H:%MZ'
    utc=1
  elif [[ "$claim" =~ ([0-9]{8})$ ]]; then
    # Legacy claims contain the operator's local calendar date, not a UTC instant.
    stamp="${BASH_REMATCH[1]}"
    format='%Y%m%d'
  elif [[ "$claim" =~ ([0-9]{4}-[0-9]{2}-[0-9]{2})$ ]]; then
    stamp="${BASH_REMATCH[1]}"
    format='%Y-%m-%d'
  else
    return 0
  fi

  if [ "$utc" -eq 1 ]; then
    if epoch=$(date -j -u -f "$format" "$stamp" '+%s' 2>/dev/null); then
      printf '%s\n' "$epoch"
    else
      date -u -d "$stamp" '+%s' 2>/dev/null || true
    fi
  elif epoch=$(date -j -f "$format" "$stamp" '+%s' 2>/dev/null); then
    printf '%s\n' "$epoch"
  else
    date -d "$stamp" '+%s' 2>/dev/null || true
  fi
}

cmd_claims() {
  local fix=0 stale_hours='' stale_cutoff_epoch='' now_epoch claim_epoch claim_age_hours
  local arg tab total pages page args data claim count state session ticket_id update_args timestamp
  local live_file worktree_file claims_file status_file
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --fix) fix=1 ;;
      --stale)
        [ "$#" -ge 2 ] || die "--stale requires hours (usage: $0 claims [--fix] [--stale <hours>])"
        stale_hours="$2"
        shift
        [[ "$stale_hours" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
          die "--stale hours must be a non-negative number"
        ;;
      -*) die "unknown option: $arg (usage: $0 claims [--fix] [--stale <hours>])" ;;
      *) die "unexpected argument for claims: $arg" ;;
    esac
    shift
  done
  if [ -n "$stale_hours" ] && [ "$fix" -eq 1 ]; then
    die "--stale is report-only and cannot be combined with --fix"
  fi
  if [ -n "$stale_hours" ]; then
    now_epoch=$(date '+%s')
    stale_cutoff_epoch=$(awk -v now="$now_epoch" -v hours="$stale_hours" \
      'BEGIN { printf "%.0f", now - (hours * 3600) }')
  fi

  command -v jq >/dev/null 2>&1 || die "jq is required for claims"
  PULSE_CLAIMS_TMP=$(mktemp -d "${TMPDIR:-/tmp}/codex-claims.XXXXXX")
  trap 'rm -rf "$PULSE_CLAIMS_TMP"' EXIT
  live_file="$PULSE_CLAIMS_TMP/live"
  worktree_file="$PULSE_CLAIMS_TMP/worktrees"
  claims_file="$PULSE_CLAIMS_TMP/claims"
  status_file="$PULSE_CLAIMS_TMP/status"
  pulse_claim_live_sessions > "$live_file"
  pulse_claim_worktree_names > "$worktree_file"
  : > "$claims_file"

  echo "Pulse claims: workspace=$PULSE_CLAIM_WORKSPACE division=$PULSE_CLAIM_DIVISION"
  tab=all
  args=$(jq -cn --arg business_id "$PULSE_CLAIM_WORKSPACE" \
    --arg division "$PULSE_CLAIM_DIVISION" --arg tab_filter "$tab" \
    '{business_id:$business_id,division:$division,tab_filter:$tab_filter,stats:true}')
  total=$(pulse_claim_call pulse_list_tickets "$args" | jq -er '.total_tickets // 0') ||
    die "Pulse claims stats did not return total_tickets"
  pages=$(( (total + 24) / 25 ))
  for ((page = 1; page <= pages; page += 1)); do
    args=$(jq -cn --arg business_id "$PULSE_CLAIM_WORKSPACE" \
      --arg division "$PULSE_CLAIM_DIVISION" --arg tab_filter "$tab" \
      --argjson page "$page" '{business_id:$business_id,division:$division,tab_filter:$tab_filter,page:$page,page_size:25}')
    data=$(pulse_claim_call pulse_list_tickets "$args")
    printf '%s\n' "$data" | jq -r '.data[]? | select(.custom_fields.worked_by != null and (.custom_fields.worked_by | tostring | length) > 0) | [.custom_fields.worked_by, .id] | @tsv' >> "$claims_file"
  done

  printf '%s\n' "CLAIM STRING"$'\t'"TICKETS"$'\t'"STATE"$'\t'"SESSION"
  cut -f1 "$claims_file" | sort -u | while IFS= read -r claim; do
    [ -n "$claim" ] || continue
    count=$(awk -F '\t' -v wanted="$claim" '$1 == wanted { count += 1 } END { print count + 0 }' "$claims_file")
    IFS=$'\t' read -r state session <<EOF
$(pulse_claim_session_for "$claim" "$live_file" "$worktree_file")
EOF
    printf '%s\t%s\t%s\t%s\n' "$claim" "$count" "$state" "$session" >> "$status_file"
  done
  sort -t $'\t' -k1,1 "$status_file"

  if [ -n "$stale_hours" ]; then
    echo
    printf 'Stale live claims older than %s hours (report-only; no claims cleared)\n' "$stale_hours"
    printf '%s\n' "STATE"$'\t'"CLAIM STRING"$'\t'"TICKETS"$'\t'"AGE HOURS"$'\t'"TIMESTAMP"$'\t'"SESSION"
    while IFS=$'\t' read -r claim count state session; do
      [ "$state" = "LIVE" ] || continue
      claim_epoch=$(pulse_claim_timestamp "$claim")
      [ -n "$claim_epoch" ] || continue
      if [ "$claim_epoch" -ge "$stale_cutoff_epoch" ]; then
        continue
      fi
      claim_age_hours=$(awk -v now="$now_epoch" -v claimed="$claim_epoch" \
        'BEGIN { printf "%.1f", (now - claimed) / 3600 }')
      timestamp=$(date -u -r "$claim_epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null ||
        date -u -d "@$claim_epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null ||
        printf 'unknown')
      printf 'STALE\t%s\t%s\t%s\t%s\t%s\n' \
        "$claim" "$count" "$claim_age_hours" "$timestamp" "$session"
    done < "$status_file"
  fi

  if [ "$fix" -eq 0 ]; then
    return 0
  fi

  while IFS=$'\t' read -r claim count state session; do
    [ "$state" = "DEAD" ] || continue
    while IFS=$'\t' read -r claim_from_row ticket_id; do
      [ "$claim_from_row" = "$claim" ] || continue
      update_args=$(jq -cn --arg business_id "$PULSE_CLAIM_WORKSPACE" \
        --arg ticket_id "$ticket_id" \
        '{business_id:$business_id,ticket_id:$ticket_id,custom_fields:{worked_by:null}}')
      pulse_claim_call pulse_update_ticket "$update_args" >/dev/null
      printf 'CLEARED\t%s\t%s\n' "$claim" "$ticket_id"
    done < "$claims_file"
  done < "$status_file"
}

turn() {
  local session="$1" text="$2" before
  require_session "$session"
  is_busy "$session" && die "'$session' is mid-turn; wait or run: $0 read $session"
  before=$(line_count "$session")
  submit "$session" "$text"
  wait_idle "$session"
  transcript "$session" | tail -n +"$((before + 1))"
}

cmd_send() {
  local session="${1:?usage: $0 send <session> <brief-file>}"
  local brief="${2:?usage: $0 send <session> <brief-file>}"
  [ -f "$brief" ] || die "brief not found: $brief"
  require_owner "$session" "send to" "${3:-}"
  turn "$session" "Read the file $brief and carry out the task it describes. Follow it exactly."
}

cmd_ask() {
  local session="${1:?usage: $0 ask <session> <text>}"
  local text="${2:?usage: $0 ask <session> <text>}"
  require_owner "$session" "ask" "${3:-}"
  turn "$session" "$text"
}

# Fire-and-forget: hand over the brief and return so the caller can do other
# work and check back later instead of blocking on the whole turn.
# A ticket brief must carry the Gate A checklist, so the session is asked for a
# baseline and its owner-routing before it can report anything else. The manager
# is the one who forgets this, not the session: the rule lived as prose in an
# untracked /tmp tail for a tick and reached nobody. Enforce it at the boundary
# rather than trusting a long session to remember appending it.
require_gate_a() { # require_gate_a <brief> <no_gate_reason>
  local brief="$1" reason="$2"
  if [ -n "$reason" ]; then
    echo "codex-session: gate-A check skipped — $reason" >&2
    return 0
  fi
  grep -q 'A1 baseline' "$brief" && return 0
  die "refusing to dispatch: '$brief' has no Gate A checklist.

  Every ticket brief ends with the tracked tail:
    cat .agents/skills/pulse-tenant-sweep/templates/brief-tail.md >> '$brief'

  It makes the session answer A1 baseline / A2 denominator / A3 owner / A4 status
  before any other result, and routes a 9/10 or 10/10 baseline to an engineer
  (In Progress PM & Eng) instead of a spec edit.

  For a brief that is genuinely not ticket work — a release investigation, an
  artifact sweep — pass:  --no-gate \"<reason>\""
}

cmd_dispatch() {
  local session="${1:?usage: $0 dispatch <session> <brief-file> [--adopt] [--no-gate <reason>]}"
  local brief="${2:?usage: $0 dispatch <session> <brief-file> [--adopt] [--no-gate <reason>]}"
  shift 2
  local adopt="" no_gate=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --adopt) adopt="--adopt"; shift ;;
      --no-gate) no_gate="${2:?--no-gate needs a reason}"; shift 2 ;;
      *) die "unknown dispatch flag: $1" ;;
    esac
  done
  require_session "$session"
  require_owner "$session" "dispatch to" "$adopt"
  [ -f "$brief" ] || die "brief not found: $brief"
  require_gate_a "$brief" "$no_gate"
  is_busy "$session" && die "'$session' is mid-turn"
  line_count "$session" >"${TMPDIR:-/tmp}/.codex-mark-$session"
  submit "$session" "Read the file $brief and carry out the task it describes. Follow it exactly."
  # Codex intermittently leaves the pasted brief sitting at the prompt with the
  # Enter unconsumed, so a returning `submit` is not proof the turn started.
  # Poll briefly, press Enter once more, then poll again — cheaper and more
  # reliable than the caller guessing a sleep and pressing Enter blind.
  local waited=0
  while [ "$waited" -lt 12 ]; do
    is_busy "$session" && { echo "dispatched to $session; turn started"; return 0; }
    sleep 2
    waited=$((waited + 2))
  done
  tmux send-keys -t "$session" Enter
  waited=0
  while [ "$waited" -lt 10 ]; do
    is_busy "$session" && { echo "dispatched to $session; turn started after a second Enter"; return 0; }
    sleep 2
    waited=$((waited + 2))
  done
  echo "dispatched to $session, but it is NOT busy after 22s — inspect: $0 read $session" >&2
  return 1
}

cmd_wait() {
  local session="${1:?usage: $0 wait <session>}" mark
  require_session "$session"
  wait_idle "$session"
  mark=$(cat "${TMPDIR:-/tmp}/.codex-mark-$session" 2>/dev/null || echo 0)
  transcript "$session" | tail -n +"$((mark + 1))"
}

cmd_read() {
  require_session "${1:?usage: $0 read <session> [n]}"
  transcript "$1" | tail -n "${2:-120}"
}

cmd_status() {
  require_session "${1:?usage: $0 status <session>}"
  is_busy "$1" && echo busy || echo idle
}

print_verify_sha_help() {
  cat <<'EOF'
Usage: codex-session.sh verify-sha <ticket-id> <sha> --path <file>[:<line>] [--path ...] [--in-image]

Resolve a commit and verify that every caller-supplied path is touched by its
diff. The path is the ticket symptom's implicated file; this command does not
guess one. A trailing line number is accepted for human-readable references.

Options:
  --path <file>[:<line>]  Required; repeat for every implicated path.
  --in-image              Delegate running-image ancestry to `boundary` when it
                          is available; fail closed if that seam is unavailable.

Known trap: inbound and outbound duplicate delivery are different paths.
1650c3f3cc and c95279e0bd fix inbound; 292bf1478c fixes outbound. A
duplicate-outbound ticket carrying an inbound SHA is plausible but wrong.
EOF
}

script_repo() {
  git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null ||
    die "not inside a git repository"
}

normalize_verify_path() {
  local path="$1"
  if [[ "$path" =~ ^(.*):([0-9]+)$ ]]; then
    path="${BASH_REMATCH[1]}"
  fi
  printf '%s\n' "${path#./}"
}

cmd_verify_sha() {
  if [ "${1:-}" = "--help" ]; then
    print_verify_sha_help
    return 0
  fi

  local ticket_id="${1:-}" requested_sha="${2:-}" in_image=0 arg
  local repo resolved stat_output changed_files requested normalized changed touched
  local path_failure=0 image_failure=0 boundary_output image_line
  local -a requested_paths=()

  [ -n "$ticket_id" ] && [ -n "$requested_sha" ] ||
    die "usage: $0 verify-sha <ticket-id> <sha> --path <file>[:<line>] [--path ...] [--in-image]"
  shift 2

  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --path)
        [ "$#" -ge 2 ] || die "--path needs a value"
        requested_paths+=("$2")
        shift 2
        ;;
      --in-image)
        in_image=1
        shift
        ;;
      --help)
        print_verify_sha_help
        return 0
        ;;
      -*)
        die "unknown option: $arg"
        ;;
      *)
        die "unexpected argument for verify-sha: $arg"
        ;;
    esac
  done

  [ "${#requested_paths[@]}" -gt 0 ] ||
    die "verify-sha requires at least one --path"

  repo=$(script_repo)
  case "$requested_sha" in
    ''|*[!0-9a-fA-F]*)
      echo "FAIL ticket=$ticket_id sha=$requested_sha"
      echo "CHANGED_FILES: unavailable (the SHA must be hexadecimal)"
      return 1
      ;;
  esac

  if ! resolved=$(git -C "$repo" rev-parse --verify "$requested_sha^{commit}" 2>/dev/null); then
    echo "FAIL ticket=$ticket_id sha=$requested_sha"
    echo "CHANGED_FILES: unavailable (commit does not exist in $repo)"
    return 1
  fi

  if ! stat_output=$(git -C "$repo" show --stat --oneline --decorate "$resolved"); then
    echo "FAIL ticket=$ticket_id sha=$requested_sha resolved=$resolved"
    echo "CHANGED_FILES: unavailable (git show --stat failed)"
    return 1
  fi
  if ! changed_files=$(git -C "$repo" show --format= --name-only --diff-filter=ACDMRTUXB "$resolved"); then
    echo "FAIL ticket=$ticket_id sha=$requested_sha resolved=$resolved"
    echo "CHANGED_FILES: unavailable (could not enumerate the commit diff)"
    return 1
  fi

  echo "TICKET=$ticket_id"
  echo "REQUESTED_SHA=$requested_sha"
  echo "RESOLVED_SHA=$resolved"
  echo "GIT_SHOW_STAT:"
  printf '%s\n' "$stat_output"
  echo "CHANGED_FILES:"
  if [ -n "$changed_files" ]; then
    printf '%s\n' "$changed_files"
  else
    echo "(none)"
  fi

  for requested in "${requested_paths[@]}"; do
    normalized=$(normalize_verify_path "$requested")
    touched=0
    while IFS= read -r changed; do
      [ "$changed" = "$normalized" ] && touched=1
    done <<< "$changed_files"
    if [ "$touched" -eq 1 ]; then
      echo "PATH path=$requested normalized=$normalized touched=yes"
    else
      echo "PATH path=$requested normalized=$normalized touched=no"
      path_failure=1
    fi
  done

  if [ "$in_image" -eq 1 ]; then
    # `boundary` owns the live GKE/workflow lookup. Keep this seam here so the
    # verifier reuses that proof when the boundary subcommand lands, rather than
    # creating a second source of truth for the running image.
    if ! declare -F cmd_boundary >/dev/null 2>&1; then
      echo "IN_IMAGE=unavailable (boundary subcommand has not landed)"
      image_failure=1
    elif boundary_output=$(cmd_boundary "$resolved"); then
      image_line=$(printf '%s\n' "$boundary_output" | awk -v wanted="$resolved" '$1 == wanted && $2 == "IN" && $3 == "running" && $4 == "image"')
      if [ -n "$image_line" ]; then
        echo "IN_IMAGE=yes"
      else
        echo "IN_IMAGE=no"
        image_failure=1
      fi
    else
      echo "IN_IMAGE=unavailable (boundary lookup failed)"
      image_failure=1
    fi
  fi

  if [ "$path_failure" -eq 0 ] && [ "$image_failure" -eq 0 ]; then
    echo "PASS ticket=$ticket_id sha=$resolved"
    return 0
  fi
  echo "FAIL ticket=$ticket_id sha=$resolved"
  return 1
}

validate_closeout_attestation() { # validate_closeout_attestation <label> <value>
  local label="$1" value="$2"
  is_real_closeout_value "$value" ||
    die "$label must be a real value; empty and placeholders are not accepted"
  case "$value" in
    *$'\n'*|*$'\r'*) die "$label must be a single-line value" ;;
  esac
}

# The ledger is the durable working document for a session's ticket work. Keep
# this check here, beside the closeout write, so a session cannot be recorded as
# complete before its ticket row carries the two fields the director uses to
# distinguish throughput from bookkeeping. The fields are being provisioned on
# Pulse independently, so an older checkout (or a workspace that has not yet
# received the definitions) must remain usable but must say that this check was
# unavailable. A missing definition is not evidence that every ticket passed.
validate_ticket_closeout_fields() { # validate_ticket_closeout_fields <id,id,...>
  local ticket_ids="$1" ledger header ticket found evidence root
  local -a ticket_list
  ledger="${PULSE_LEDGER_PATH:-$(main_repo)/.artifacts/orchestration/pulse-ledger.md}"

  if [ ! -f "$ledger" ]; then
    echo "WARNING: skipped ticket root_cause/evidence check; ledger is unavailable at '$ledger'." >&2
    return 0
  fi

  header=$(grep -iE '^\|.*Ticket.*Evidence.*Root[[:space:]]+cause.*\|$' "$ledger" | head -1 || true)
  if [ -z "$header" ]; then
    echo "WARNING: skipped ticket root_cause/evidence check; field definitions are absent from '$ledger'." >&2
    return 0
  fi

  IFS=',' read -r -a ticket_list <<< "$ticket_ids"
  for ticket in "${ticket_list[@]}"; do
    ticket=$(printf '%s' "$ticket" | tr -d '[:space:]')
    [ -n "$ticket" ] || die "--tickets must contain non-empty ticket ids"
    found=0
    evidence=""
    root=""
    while IFS=$'\034' read -r _row_id evidence root; do
      [ "$_row_id" = "$ticket" ] || continue
      found=1
      break
    done < <(awk -F'|' -v wanted="$ticket" '
      function trim(value) {
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        gsub(/^`|`$/, "", value)
        return value
      }
      $0 ~ /^\|/ {
        id = trim($2)
        if (id == wanted) {
          # The final three logical cells are Evidence, Area, Root cause. Using
          # the tail keeps the check useful when a client title contains an
          # unescaped pipe and shifted the middle cells in an old row.
          print id "\034" trim($(NF - 3)) "\034" trim($(NF - 1))
        }
      }
    ' "$ledger")

    if [ "$found" -eq 0 ]; then
      echo "codex-session: ticket '$ticket' is missing root_cause and evidence (no ledger row)" >&2
      return 1
    fi
    if [ -z "$(printf '%s' "$root" | tr -d '[:space:]')" ]; then
      echo "codex-session: ticket '$ticket' is missing root_cause" >&2
      return 1
    fi
    if [ -z "$(printf '%s' "$evidence" | tr -d '[:space:]')" ]; then
      echo "codex-session: ticket '$ticket' is missing evidence" >&2
      return 1
    fi
  done
}

cmd_closeout() {
  local session="${1:?usage: $0 closeout <session> [--tickets <id[,id...]>] --finalize-sha <sha> --deployed <mechanism> --validated <evidence>}"
  local finalize_sha="" deployed="" validated="" no_ship="" tickets="" adopt="" arg repo resolved
  shift
  while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --finalize-sha) finalize_sha="${2:?--finalize-sha needs a value}"; shift 2 ;;
      --deployed) deployed="${2:?--deployed needs a value}"; shift 2 ;;
      --validated) validated="${2:?--validated needs a value}"; shift 2 ;;
      --no-ship) no_ship="${2:?--no-ship needs a reason}"; shift 2 ;;
      --tickets) tickets="${2:?--tickets needs a value}"; shift 2 ;;
      --adopt) adopt="--adopt"; shift ;;
      -*) die "unknown option: $arg" ;;
      *) die "unexpected argument for closeout: $arg" ;;
    esac
  done
  # Deliberately NOT require_session. A session whose tmux pane is gone — it
  # crashed, the machine restarted, or the batch that launched it was killed
  # (exit 144, low memory, four dispatches lost) — is exactly the one that needs
  # closing out, and refusing here is what stranded 74 worktrees on this machine:
  # closeout could not be recorded, so `stop` refused forever and the tree became
  # invisible state no sweep would find. The state file is the record of the
  # session, and it carries the owner, so the ownership check below still holds.
  if ! tmux has-session -t "$session" 2>/dev/null; then
    [ -f "$(state_file "$session")" ] ||
      die "no session '$session' and no recorded state for it. Run: $0 list"
    echo "note: '$session' has no live tmux pane; closing out from its state record" >&2
  fi
  require_owner "$session" "record closeout" "$adopt"
  repo=$(read_state "$session" repo 2>/dev/null) ||
    die "no recorded worktree for '$session'"

  # /finalize-change removes the worktree it ran in, which used to strand the
  # session: closeout fetched origin/main from the now-absent directory and
  # failed, and `stop` then refused for want of the closeout record it could
  # never write. The SHA is verified against origin/main, not against anything
  # local to the worktree, so any checkout of this repository answers the same
  # question. Fall back to the one this script lives in.
  if [ ! -d "$repo" ]; then
    repo=$(main_repo)
    echo "note: '$session' worktree is gone (finalize-change removes it); verifying against $repo" >&2
  fi

  if [ -n "$tickets" ]; then
    validate_ticket_closeout_fields "$tickets" || return 1
  fi

  if [ -n "$no_ship" ]; then
    [ -z "$finalize_sha" ] && [ -z "$deployed" ] && [ -z "$validated" ] ||
      die "choose either the three shipping fields or --no-ship, not both"
    validate_closeout_attestation "--no-ship reason" "$no_ship"
    write_closeout "$session" no-ship "" "" "" "$no_ship"
    echo "recorded closeout for '$session': no-ship — $no_ship"
    return 0
  fi

  [ -n "$finalize_sha" ] || die "--finalize-sha is required (or use --no-ship <reason>)"
  [ -n "$deployed" ] || die "--deployed is required (or use --no-ship <reason>)"
  [ -n "$validated" ] || die "--validated is required (or use --no-ship <reason>)"
  validate_closeout_attestation "--deployed" "$deployed"
  validate_closeout_attestation "--validated" "$validated"
  if ! resolved=$(verify_finalize_sha "$repo" "$finalize_sha"); then
    return 1
  fi
  write_closeout "$session" ship "$resolved" "$deployed" "$validated" ""
  echo "recorded closeout for '$session': finalize=$resolved deploy=$deployed validate=$validated"
}

cmd_repo() {
  read_state "${1:?usage: $0 repo <session>}" repo ||
    die "no recorded worktree for '$1'"
}

# Remove a worktree this script created. Refuses to destroy work: a dirty tree or
# commits that are not on origin/main stop the removal unless --force is given.
remove_worktree() {
  local session="$1" force="$2" delete_branch="$3"
  local repo dir branch owned unpushed
  repo=$(main_repo)
  dir=$(read_state "$session" repo 2>/dev/null || true)
  branch=$(read_state "$session" branch 2>/dev/null || true)
  owned=$(read_state "$session" owned 2>/dev/null || echo 0)

  if [ -z "$dir" ]; then
    echo "no recorded worktree for '$session'; nothing to remove"
    return 0
  fi
  if [ "$owned" != "1" ]; then
    echo "worktree $dir was not created by this script; left on disk"
    return 0
  fi
  if [ ! -d "$dir" ]; then
    git -C "$repo" worktree prune
    rm -f "$(state_file "$session")"
    echo "worktree $dir already gone"
    return 0
  fi

  if [ "$force" -eq 0 ]; then
    if is_dirty "$dir"; then
      echo "NOT removed: $dir has uncommitted work." >&2
      echo "  Finish it (/finalize-change), or re-run with --force to discard it." >&2
      return 1
    fi
    unpushed=$(git -C "$dir" log --oneline "@{upstream}..HEAD" 2>/dev/null ||
      git -C "$repo" log --oneline "origin/main..$branch" 2>/dev/null || true)
    if [ -n "$unpushed" ]; then
      echo "NOT removed: $branch has commits that are not on origin/main:" >&2
      echo "$unpushed" >&2
      echo "  Push them (/finalize-change), or re-run with --force to discard them." >&2
      return 1
    fi
  fi

  # Last point at which the session's own findings still exist. A failure here
  # keeps the tree: an unarchived worksheet is unrecoverable once the tree goes,
  # and --force means "discard the code", never "discard the evidence".
  if ! archive_worksheets "$session" "$dir"; then
    echo "NOT removed: could not archive worksheets from $dir" >&2
    echo "  Rescue them by hand, then re-run stop, or pass --keep-worktree." >&2
    return 1
  fi

  if [ "$force" -eq 1 ]; then
    git -C "$repo" worktree remove --force "$dir" || die "could not remove worktree $dir"
  else
    # The guards above already proved the tree holds nothing but our own brief
    # scaffolding, which git still counts as untracked and refuses to remove
    # over. Passing --force here is not discarding work; it is the only way to
    # clear a tree we have already established is clean.
    git -C "$repo" worktree remove --force "$dir" || die "could not remove worktree $dir"
  fi
  git -C "$repo" worktree prune
  rm -f "$(state_file "$session")"
  echo "removed worktree $dir"
  if [ "$delete_branch" -eq 1 ] && [ -n "$branch" ]; then
    if git -C "$repo" branch -D "$branch" >/dev/null 2>&1; then
      echo "deleted branch $branch"
    else
      echo "branch $branch could not be deleted; check it in $repo"
    fi
  else
    echo "branch $branch kept in $repo"
  fi
}

# Shared by stop and stop-all. Sets KEEP/FORCE/DELBRANCH and STOP_TARGET.
parse_stop_opts() {
  KEEP=0; FORCE=0; DELBRANCH=0; STOP_TARGET=""; ADOPT=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      --keep-worktree|--keep-worktrees) KEEP=1 ;;
      --force) FORCE=1 ;;
      --delete-branch) DELBRANCH=1 ;;
      --adopt) ADOPT="--adopt" ;;
      -*) die "unknown option: $arg" ;;
      *) STOP_TARGET="$arg" ;;
    esac
  done
}

cmd_stop() {
  parse_stop_opts "$@"
  local session="$STOP_TARGET"
  [ -n "$session" ] || die "usage: $0 stop <session> [--keep-worktree] [--force] [--delete-branch]"
  require_owner "$session" "stop" "$ADOPT"
  closeout_gate "$session" "$FORCE" || return 1
  tmux kill-session -t "$session" 2>/dev/null && echo "released '$session'" ||
    echo "no session '$session'"
  if [ "$KEEP" -eq 1 ]; then
    echo "worktree kept: $(read_state "$session" repo 2>/dev/null || echo unknown)"
    return 0
  fi
  remove_worktree "$session" "$FORCE" "$DELBRANCH"
}

cmd_stop_all() {
  parse_stop_opts "$@"
  local session found=0 rc=0 skipped=0 me
  me=$(owner_id)
  while read -r session; do
    [ -n "$session" ] || continue
    # Default to this manager's own sessions. The director and other managers
    # run sessions on the same machine; an unscoped stop-all wipes their work.
    if [ "$ADOPT" != "--adopt" ] && [ "$(session_owner "$session")" != "$me" ]; then
      echo "skipped '$session' (owned by '$(session_owner "$session")')"
      skipped=1
      continue
    fi
    if ! closeout_gate "$session" "$FORCE"; then
      rc=1
      continue
    fi
    tmux kill-session -t "$session" 2>/dev/null && echo "released '$session'" && found=1
    if [ "$KEEP" -eq 0 ]; then
      remove_worktree "$session" "$FORCE" "$DELBRANCH" || rc=1
    fi
  done < <(tmux list-sessions -F '#S' 2>/dev/null | grep "^${PREFIX}" || true)
  [ "$found" -eq 0 ] && echo "no codex sessions running for '$me'"
  [ "$skipped" -eq 1 ] && echo "pass --adopt to include sessions owned by others"
  return "$rc"
}

# The Rule 1 sweep, scoped to sessions you actually acquired. Prints one line per
# session with its busy/idle state, so an idle row is a deliverable to advance,
# release, or escalate — and someone else's idle row is not your problem.
cmd_mine() {
  local session me found=0
  me=$(owner_id)
  while read -r session; do
    [ -n "$session" ] || continue
    [ "$(session_owner "$session")" = "$me" ] || continue
    found=1
    printf "%-28s %-6s %s\n" "$session" \
      "$(is_busy "$session" && echo busy || echo IDLE)" \
      "$(read_state "$session" branch 2>/dev/null || echo '?')"
  done < <(tmux list-sessions -F '#S' 2>/dev/null | grep "^${PREFIX}" || true)
  [ "$found" -eq 0 ] && echo "no sessions owned by '$me'"
  return 0
}

# ---------------------------------------------------------------------------
# Live validation boundary
#
# This is deliberately read-only and does not use a release ref or a ledger
# entry. Every invocation reads GKE, the named deploy workflow, and origin/main
# again: a cached boundary is the failure this command exists to prevent.
# ---------------------------------------------------------------------------

BOUNDARY_CONTEXT="gke_halo-ai-469606_asia-southeast2_data-infra-jkt"
BOUNDARY_NAMESPACE="haloai-jkt"
BOUNDARY_DEPLOYMENT="haloai-web"
BOUNDARY_WORKFLOW_NAME="Deploy Prod: Web (GKE, Jakarta)"
BOUNDARY_DEPLOY_JOB="Deploy Web and Cloud Run Jobs"
BOUNDARY_FENCES_FILE="$(dirname "${BASH_SOURCE[0]}")/../references/standing-fences.md"

boundary_require_command() {
  command -v "$1" >/dev/null 2>&1 || die "boundary requires '$1'"
}

boundary_read_cluster() {
  local deployment_json pod_json rs_json ready_containers ready_images ready_owners
  local desired ready updated available current_revision current_rs
  local older_rs_count older_nonzero_count image_id
  boundary_require_command kubectl
  boundary_require_command jq

  deployment_json=$(kubectl --context "$BOUNDARY_CONTEXT" -n "$BOUNDARY_NAMESPACE" \
    get deployment "$BOUNDARY_DEPLOYMENT" -o json 2>/dev/null) ||
    die "could not read GKE deployment '$BOUNDARY_DEPLOYMENT' in '$BOUNDARY_NAMESPACE'"
  pod_json=$(kubectl --context "$BOUNDARY_CONTEXT" -n "$BOUNDARY_NAMESPACE" \
    get pods -l app="$BOUNDARY_DEPLOYMENT" -o json 2>/dev/null) ||
    die "could not read GKE pods for '$BOUNDARY_DEPLOYMENT'"
  rs_json=$(kubectl --context "$BOUNDARY_CONTEXT" -n "$BOUNDARY_NAMESPACE" \
    get rs -l app="$BOUNDARY_DEPLOYMENT" -o json 2>/dev/null) ||
    die "could not read ReplicaSets for '$BOUNDARY_DEPLOYMENT'"

  desired=$(printf '%s' "$deployment_json" | jq -r '.spec.replicas // empty')
  ready=$(printf '%s' "$deployment_json" | jq -r '.status.readyReplicas // 0')
  updated=$(printf '%s' "$deployment_json" | jq -r '.status.updatedReplicas // 0')
  available=$(printf '%s' "$deployment_json" | jq -r '.status.availableReplicas // 0')
  current_revision=$(printf '%s' "$deployment_json" | jq -r \
    '.metadata.annotations["deployment.kubernetes.io/revision"] // empty')
  [ -n "$desired" ] || die "GKE deployment response had no desired replica count"
  [ -n "$current_revision" ] || die "GKE deployment response had no current revision"

  ready_containers=$(printf '%s' "$pod_json" | jq '[
    .items[]
    | select(.metadata.deletionTimestamp == null)
    | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))
    | .status.containerStatuses[]?
    | select(.name == "web")
  ] | length')
  ready_images=$(printf '%s' "$pod_json" | jq -r '[
    .items[]
    | select(.metadata.deletionTimestamp == null)
    | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))
    | .status.containerStatuses[]?
    | select(.name == "web")
    | .image
  ] | unique | if length == 1 then .[0] else empty end')
  image_id=$(printf '%s' "$pod_json" | jq -r '[
    .items[]
    | select(.metadata.deletionTimestamp == null)
    | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))
    | .status.containerStatuses[]?
    | select(.name == "web")
    | .imageID
  ] | unique | if length == 1 then .[0] else empty end')
  ready_owners=$(printf '%s' "$pod_json" | jq -r '[
    .items[]
    | select(.metadata.deletionTimestamp == null)
    | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))
    | .metadata.ownerReferences[]?
    | select(.kind == "ReplicaSet")
    | .name
  ] | unique | if length == 1 then .[0] else empty end')

  [ "$ready_containers" -gt 0 ] || die "GKE has no non-terminating Ready web pod"
  [ -n "$ready_images" ] || die "GKE Ready web pods do not agree on one image tag"
  [ -n "$image_id" ] || die "GKE Ready web pods do not agree on one image digest"
  case "$image_id" in
    *@sha256:*) ;;
    *) die "GKE returned an unusable web image id: $image_id" ;;
  esac

  current_rs=$(printf '%s' "$rs_json" | jq -r --arg revision "$current_revision" '
    [.items[] | select(.metadata.annotations["deployment.kubernetes.io/revision"] == $revision) | .metadata.name]
    | if length == 1 then .[0] else empty end')
  [ -n "$current_rs" ] ||
    die "could not identify ReplicaSet for current deployment revision '$current_revision'"
  older_rs_count=$(printf '%s' "$rs_json" | jq --arg current "$current_rs" \
    '[.items[] | select(.metadata.name != $current)] | length')
  older_nonzero_count=$(printf '%s' "$rs_json" | jq --arg current "$current_rs" '
    [.items[]
     | select(.metadata.name != $current)
     | select((.spec.replicas // 0) != 0
       or (.status.replicas // 0) != 0
       or (.status.readyReplicas // 0) != 0
       or (.status.availableReplicas // 0) != 0)]
    | length')

  if [ "$ready" -ne "$desired" ] || [ "$updated" -ne "$desired" ] ||
    [ "$available" -ne "$desired" ] || [ "$ready_containers" -ne "$desired" ] ||
    [ "$older_nonzero_count" -ne 0 ] || [ "$ready_owners" != "$current_rs" ]; then
    die "GKE deployment '$BOUNDARY_DEPLOYMENT' rollout is not settled: revision=$current_revision desired=$desired ready=$ready updated=$updated available=$available ready_pods=$ready_containers older_nonzero=$older_nonzero_count ready_owners=${ready_owners:-none} current_rs=$current_rs"
  fi

  BOUNDARY_IMAGE_TAG="${ready_images##*:}"
  BOUNDARY_IMAGE_DIGEST="${image_id##*@}"
  BOUNDARY_READY_REPLICAS="$ready"
  BOUNDARY_DESIRED_REPLICAS="$desired"
  BOUNDARY_READY_POD_CONTAINERS="$ready_containers"
  BOUNDARY_CURRENT_RS="$current_rs"
  BOUNDARY_OLDER_RS_COUNT="$older_rs_count"
  BOUNDARY_OLDER_NONZERO_COUNT="$older_nonzero_count"
}

boundary_read_workflow() {
  local run_list run_line run_id run_sha run_view deploy_completion
  local image_commit_prefix workflow_name
  boundary_require_command gh
  boundary_require_command jq

  image_commit_prefix="${BOUNDARY_IMAGE_TAG#web:}"
  image_commit_prefix="${image_commit_prefix%-jkt}"
  if [[ ! "$image_commit_prefix" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    die "running image tag '$BOUNDARY_IMAGE_TAG' is not a commit-derived Jakarta tag"
  fi

  run_list=$(gh run list --workflow "$BOUNDARY_WORKFLOW_NAME" --limit 50 \
    --json databaseId,name,status,conclusion,headSha,createdAt,updatedAt 2>/dev/null) ||
    die "could not read GitHub Actions workflow '$BOUNDARY_WORKFLOW_NAME'"
  run_line=$(printf '%s' "$run_list" | jq -r \
    --arg workflow "$BOUNDARY_WORKFLOW_NAME" \
    --arg prefix "$image_commit_prefix" '
      [.[]
       | select(.name == $workflow
         and .status == "completed"
         and .conclusion == "success"
         and (.headSha | startswith($prefix)))]
      | sort_by(.updatedAt)
      | reverse
      | .[0]
      | if . == null then empty else [.databaseId, .name, .headSha] | @tsv end')
  [ -n "$run_line" ] ||
    die "no successful '$BOUNDARY_WORKFLOW_NAME' run matches running image '$BOUNDARY_IMAGE_TAG'"

  IFS=$'\t' read -r run_id workflow_name run_sha <<< "$run_line"
  [ "$workflow_name" = "$BOUNDARY_WORKFLOW_NAME" ] ||
    die "matched workflow name was not exact: '$workflow_name'"
  run_view=$(gh run view "$run_id" --json name,jobs 2>/dev/null) ||
    die "could not read workflow run '$run_id'"
  deploy_completion=$(printf '%s' "$run_view" | jq -r \
    --arg workflow "$BOUNDARY_WORKFLOW_NAME" \
    --arg deploy_job "$BOUNDARY_DEPLOY_JOB" '
      if .name != $workflow then empty
      else [.jobs[]
        | select(.name == $deploy_job
          and .status == "completed"
          and .conclusion == "success")
        | .completedAt]
        | sort
        | last // empty
      end')
  [ -n "$deploy_completion" ] && [ "$deploy_completion" != "0001-01-01T00:00:00Z" ] ||
    die "workflow run '$run_id' has no successful completed deploy job '$BOUNDARY_DEPLOY_JOB'"

  BOUNDARY_RUN_ID="$run_id"
  BOUNDARY_RUN_SHA="$run_sha"
  BOUNDARY_DEPLOY_COMPLETION="$deploy_completion"
}

boundary_read_git() {
  local repo running_sha origin_sha ahead_count
  repo=$(main_repo)
  git -C "$repo" fetch origin main --quiet ||
    die "could not refresh origin/main; cannot establish the running-image gap"
  running_sha=$(git -C "$repo" rev-parse --verify "${BOUNDARY_RUN_SHA}^{commit}" 2>/dev/null) ||
    die "running workflow SHA '$BOUNDARY_RUN_SHA' is not known to this repository"
  origin_sha=$(git -C "$repo" rev-parse --verify 'origin/main^{commit}' 2>/dev/null) ||
    die "origin/main is unavailable; cannot establish the running-image gap"

  if git -C "$repo" merge-base --is-ancestor "$running_sha" "$origin_sha"; then
    ahead_count=$(git -C "$repo" rev-list --count "$running_sha..$origin_sha")
    BOUNDARY_ORIGIN_MAIN_AHEAD="$( [ "$ahead_count" -gt 0 ] && echo yes || echo no )"
    BOUNDARY_ORIGIN_MAIN_GAP="$ahead_count"
  elif git -C "$repo" merge-base --is-ancestor "$origin_sha" "$running_sha"; then
    BOUNDARY_ORIGIN_MAIN_AHEAD="no"
    BOUNDARY_ORIGIN_MAIN_GAP="0"
  else
    die "running workflow SHA '$running_sha' and origin/main diverge; cannot report an ahead count"
  fi
  BOUNDARY_RUNNING_SHA="$running_sha"
  BOUNDARY_ORIGIN_MAIN_SHA="$origin_sha"
}

print_resolve_gate() {
  cat <<'EOF'
1. QUERY + DENOMINATOR: record the exact query and a non-zero count of businesses/requests that traversed successfully.
2. RECURRENCE: record RECURRENCE COUNT: 0 for the defect signature across all businesses in scope.
3. WINDOW: bound validation from the deployed image's exact completion time; 0/0 is awaiting-exposure, not a pass.
4. FIX MATCH: git show --stat <sha> must touch the reported code path.
5. RUNNING IMAGE: prove the cited SHA is an ancestor of the actual running image before moving to Resolved.
EOF
}

cmd_boundary() {
  local pull_time sha sha_resolved repo ancestry_result
  pull_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  boundary_read_cluster
  boundary_read_workflow
  boundary_read_git

  echo "RUNNING_IMAGE_TAG=web:$BOUNDARY_IMAGE_TAG"
  echo "RUNNING_IMAGE_DIGEST=$BOUNDARY_IMAGE_DIGEST"
  echo "READY_REPLICAS=$BOUNDARY_READY_REPLICAS"
  echo "DESIRED_REPLICAS=$BOUNDARY_DESIRED_REPLICAS"
  echo "READY_WEB_PODS=$BOUNDARY_READY_POD_CONTAINERS"
  echo "CURRENT_REPLICASET=$BOUNDARY_CURRENT_RS"
  if [ "$BOUNDARY_OLDER_NONZERO_COUNT" -eq 0 ]; then
    echo "OLDER_REPLICASETS_AT_ZERO=yes count=$BOUNDARY_OLDER_RS_COUNT"
  else
    echo "OLDER_REPLICASETS_AT_ZERO=no nonzero=$BOUNDARY_OLDER_NONZERO_COUNT count=$BOUNDARY_OLDER_RS_COUNT"
  fi
  echo "DEPLOY_WORKFLOW_NAME=$BOUNDARY_WORKFLOW_NAME"
  echo "DEPLOY_RUN_ID=$BOUNDARY_RUN_ID"
  echo "DEPLOY_COMPLETION_UTC=$BOUNDARY_DEPLOY_COMPLETION"
  echo "RUNNING_COMMIT=$BOUNDARY_RUNNING_SHA"
  echo "ORIGIN_MAIN=$BOUNDARY_ORIGIN_MAIN_SHA"
  echo "ORIGIN_MAIN_AHEAD=$BOUNDARY_ORIGIN_MAIN_AHEAD commits=$BOUNDARY_ORIGIN_MAIN_GAP"
  echo "PULL_TIME_UTC=$pull_time"

  if [ "$#" -gt 0 ]; then
    repo=$(main_repo)
    for sha in "$@"; do
      case "$sha" in
        ''|*[!0-9a-fA-F]*) die "boundary SHA must be hexadecimal: '$sha'" ;;
      esac
      sha_resolved=$(git -C "$repo" rev-parse --verify "$sha^{commit}" 2>/dev/null) ||
        die "boundary SHA '$sha' is not a commit known to this repository"
      if git -C "$repo" merge-base --is-ancestor "$sha_resolved" "$BOUNDARY_RUNNING_SHA"; then
        ancestry_result="IN"
      else
        ancestry_result="NOT IN"
      fi
      echo "$sha $ancestry_result running image"
    done
  fi

  echo "RESOLVE_GATE="
  print_resolve_gate
}

cmd_fences() {
  [ -f "$BOUNDARY_FENCES_FILE" ] || die "standing-fences reference not found: $BOUNDARY_FENCES_FILE"
  cat "$BOUNDARY_FENCES_FILE"
}

cmd_gate() { print_resolve_gate; }

# ---------------------------------------------------------------------------
# Fleet hygiene: doctor and sweep
#
# Every rule in this skill about where a subagent lives was prose until now, and
# prose cannot fire on a state nobody measures. A 2026-09-04 audit of one machine
# found 59 worktrees (34 of them clean AND fully pushed — pure litter), 920 local
# branches, 416 stash entries, and a main checkout 337 commits behind origin/main
# whose working tree held 510 "modified" files. 194 of those files were
# byte-identical to OLDER commits of main, spread across two months, and 126 were
# deletions of files that still exist upstream — including ten live migrations.
#
# None of it was work. Drift manufactured it: at 337 commits behind, `git status`
# cannot tell an old file from an edited one, so every fossil read as a change.
# `doctor` exists so that state is one command away instead of invisible.
# ---------------------------------------------------------------------------

# Worktrees this repository has attached, excluding the main checkout itself.
# Emits: dirty_count|unpushed_count|branch|path
fleet_rows() {
  local repo wt d u b
  repo=$(main_repo)
  for wt in $(git -C "$repo" worktree list --porcelain | awk '/^worktree /{print $2}'); do
    [ "$wt" = "$repo" ] && continue
    [ -d "$wt" ] || continue
    d=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    b=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
    u=$(git -C "$wt" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
    printf '%s|%s|%s|%s\n' "${d:-0}" "${u:-0}" "$b" "$wt"
  done
}

# Bring the director's repo back to exactly origin/main.
#
# The director's checkout holds no work — every task runs in its own worktree —
# so "current" is the only correct state for it, and staleness is not a harmless
# lag: at 337 commits behind, `git status` cannot tell an old file from an edited
# one, so stale content reads as local work. One audit found 510 such phantom
# files, 126 of them deletions of live files including ten migrations.
#
# This NEVER destroys tracked work. If the tree is dirty it reports and stops,
# because dirt in the director's repo means something wrote where it should not
# have, and that is a fact to look at rather than to bulldoze. `--force` is the
# deliberate override once the dirt is known to be worthless.
cmd_sync_main() {
  local repo force=0 arg before after dirt behind untracked_conflicts
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      -*) die "unknown option: $arg (usage: $0 sync-main [--force])" ;;
    esac
  done
  repo=$(main_repo)

  # Throttled: acquire calls this first, so without the shared stamp a wave of
  # twelve acquires fires twenty-four fetches at one `.git`.
  fetch_origin_main "$repo" || die "fetch failed; cannot sync"
  before=$(git -C "$repo" rev-parse --short HEAD)
  behind=$(git -C "$repo" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)

  dirt=$(git -C "$repo" status --porcelain --untracked-files=no | wc -l | tr -d ' ')
  if [ "$dirt" -gt 0 ] && [ "$force" -eq 0 ]; then
    echo "REFUSING: $dirt tracked file(s) modified in the director repo."
    echo "Nothing should be edited here — every task belongs in its own worktree."
    git -C "$repo" status --porcelain --untracked-files=no | head -20
    [ "$dirt" -gt 20 ] && echo "  ... and $((dirt - 20)) more"
    echo "Inspect it, then re-run with --force once you know it is worthless."
    return 1
  fi

  if [ "$behind" -eq 0 ] && [ "$dirt" -eq 0 ]; then
    echo "already at origin/main ($before)"
    return 0
  fi

  # An untracked file that origin/main now tracks blocks a fast-forward, and git's
  # own message buries the paths. Name them: they are usually a script an agent
  # left here that has since been committed properly by someone else.
  # The trailing `true` is load-bearing: `cat-file -e` exits 128 on a path that
  # is not upstream, that is the substitution's last command, and under `set -e`
  # a failing assignment kills the script — silently, since the exit is not an
  # error message. Without it this function did nothing at all in the common case
  # where no untracked file collides.
  untracked_conflicts=$(git -C "$repo" status --porcelain |
    awk '$1=="??"{print $2}' |
    while read -r f; do
      git -C "$repo" cat-file -e "origin/main:$f" 2>/dev/null && echo "$f"
    done
    true)
  if [ -n "$untracked_conflicts" ]; then
    echo "untracked files that origin/main now tracks (remove or move them first):"
    printf '  %s\n' $untracked_conflicts
    return 1
  fi

  if [ "$force" -eq 1 ]; then
    git -C "$repo" reset --hard origin/main >/dev/null
  else
    # Explicit merge, never `pull`: a repo-local pull.rebase setting turns this
    # into a rebase that fails outright on a multi-remote config.
    git -C "$repo" merge --ff-only origin/main >/dev/null ||
      die "not a fast-forward; the director repo has diverged — inspect it"
  fi

  after=$(git -C "$repo" rev-parse --short HEAD)
  echo "synced director repo: $before -> $after (+$behind)"
}

cmd_doctor() {
  local repo rows total clean dirty unpushed branches stashes behind ahead dirt
  local stale_ref=0
  repo=$(main_repo)
  # A failed fetch is not fatal, but every number below is then measured against
  # a stale origin/main and drift reads LOWER than it is. Say so rather than
  # reporting a healthy-looking count nobody can trust.
  git -C "$repo" fetch -q origin main 2>/dev/null || stale_ref=1

  rows=$(fleet_rows)
  total=$(printf '%s\n' "$rows" | grep -c . || true)
  clean=$(printf '%s\n' "$rows" | awk -F'|' '$1==0 && $2==0' | grep -c . || true)
  dirty=$(printf '%s\n' "$rows" | awk -F'|' '$1>0' | grep -c . || true)
  unpushed=$(printf '%s\n' "$rows" | awk -F'|' '$2>0' | grep -c . || true)
  branches=$(git -C "$repo" branch --list | wc -l | tr -d ' ')
  stashes=$(git -C "$repo" stash list | wc -l | tr -d ' ')
  behind=$(git -C "$repo" rev-list --count HEAD..origin/main 2>/dev/null || echo '?')
  ahead=$(git -C "$repo" rev-list --count origin/main..HEAD 2>/dev/null || echo '?')
  dirt=$(git -C "$repo" status --porcelain | wc -l | tr -d ' ')

  echo "director repo: $repo"
  [ "$stale_ref" -eq 1 ] &&
    echo "  (could not fetch; measured against a STALE origin/main — drift is at least this)"
  printf '  %-34s %s\n' "behind origin/main" "$behind"
  printf '  %-34s %s\n' "ahead of origin/main" "$ahead"
  printf '  %-34s %s\n' "uncommitted files" "$dirt"
  echo
  echo "fleet:"
  printf '  %-34s %s\n' "worktrees attached" "$total"
  printf '  %-34s %s\n' "clean + fully pushed (litter)" "$clean"
  printf '  %-34s %s\n' "dirty" "$dirty"
  printf '  %-34s %s\n' "commits not on origin/main" "$unpushed"
  printf '  %-34s %s\n' "local branches" "$branches"
  printf '  %-34s %s\n' "stash entries (SHARED)" "$stashes"
  echo

  # Thresholds are judgement calls, not invariants: crossing one means look, not
  # that anything is broken. Never make these fatal — this is a report.
  local warned=0
  if [ "$behind" != "?" ] && [ "$behind" -gt 50 ]; then
    echo "WARNING: director repo is $behind commits behind. At this distance an old"
    echo "         file is indistinguishable from an edited one, and stale content"
    echo "         reads as local work. Fix it now: $0 sync-main"
    warned=1
  fi
  if [ "$dirt" -gt 0 ]; then
    echo "WARNING: $dirt uncommitted files in the director repo. It is not a work"
    echo "         surface — subagent work belongs in a worktree."
    warned=1
  fi
  if [ "$stashes" -gt 10 ]; then
    echo "WARNING: $stashes stash entries. The stash stack is SHARED by every"
    echo "         worktree (one .git), so any pop can land another agent's work"
    echo "         in this tree. Commit WIP to the agent branch instead."
    warned=1
  fi
  # MCP tokens: a worker that cannot authenticate its MCP servers silently
  # skips every production read and reports the tool "unavailable". Check both
  # this shell (what the next acquire forwards) and the tmux server (what the
  # sessions already running actually got).
  local var tmux_missing=""
  if command -v tmux >/dev/null && tmux ls >/dev/null 2>&1; then
    for var in $(mcp_token_vars); do
      tmux show-environment -g "$var" >/dev/null 2>&1 || tmux_missing="$tmux_missing $var"
    done
  fi
  local shell_missing
  shell_missing=$(missing_mcp_token_vars | tr '\n' ' ')
  if [ -n "$shell_missing" ]; then
    echo "WARNING: MCP token(s) not set in this shell:$shell_missing"
    echo "         The next acquire cannot forward them; that worker's MCP servers"
    echo "         will fail auth. Export them (see ~/.zshrc) before acquiring."
    warned=1
  fi
  if [ -n "$tmux_missing" ]; then
    echo "WARNING: MCP token(s) absent from the tmux server env:$tmux_missing"
    echo "         Sessions already running were launched without them and have"
    echo "         no MCP access. New acquires fix the server env automatically;"
    echo "         running workers need a fresh acquire to pick them up."
    warned=1
  fi
  if [ "$clean" -gt 0 ]; then
    echo "NOTE: $clean worktree(s) are clean and fully pushed — teardown never ran."
    echo "      Remove them with: $0 sweep --remove"
  fi
  if [ "$unpushed" -gt 0 ]; then
    echo "NOTE: $unpushed worktree(s) hold commits not on origin/main. That is"
    echo "      unfinalized work, not litter — finish it, never force-remove it."
    printf '%s\n' "$rows" | awk -F'|' '$2>0 {printf "        %-42s %s commit(s)  %s\n", $3, $2, $4}'
  fi
  [ "$warned" -eq 0 ] && [ "$clean" -eq 0 ] && [ "$unpushed" -eq 0 ] && echo "fleet is clean."
  return 0
}

# Remove only worktrees that are clean AND carry nothing that is not already on
# origin/main. Anything dirty or unpushed is REPORTED, never removed: that is
# work in flight, and the whole point of the teardown refusal in `stop`.
cmd_sweep() {
  local remove=0 arg repo rows removed=0 kept=0
  for arg in "$@"; do
    case "$arg" in
      --remove) remove=1 ;;
      -*) die "unknown option: $arg (usage: $0 sweep [--remove])" ;;
    esac
  done
  repo=$(main_repo)
  # A failed fetch fails SAFE here: a stale origin/main is older, so commits that
  # are in fact upstream still count as unpushed and the worktree is kept, never
  # removed. Under-removing is the correct direction for a destructive command.
  git -C "$repo" fetch -q origin main 2>/dev/null || true
  rows=$(fleet_rows)

  while IFS='|' read -r d u b wt; do
    [ -n "$wt" ] || continue
    if [ "$d" -gt 0 ] || [ "$u" -gt 0 ]; then
      printf 'KEEP   %-40s %s dirty, %s unpushed\n' "$b" "$d" "$u"
      kept=$((kept + 1))
      continue
    fi
    # A live session still owns this worktree; removing it out from under a
    # running codex is how a session gets wedged in a deleted cwd.
    if session_exists "$(session_for "$wt")"; then
      printf 'KEEP   %-40s session still running\n' "$b"
      kept=$((kept + 1))
      continue
    fi
    if [ "$remove" -eq 1 ]; then
      if git -C "$repo" worktree remove "$wt" 2>/dev/null; then
        printf 'REMOVE %-40s %s\n' "$b" "$wt"
        removed=$((removed + 1))
      else
        printf 'FAILED %-40s %s\n' "$b" "$wt"
        kept=$((kept + 1))
      fi
    else
      printf 'WOULD  %-40s %s\n' "$b" "$wt"
      removed=$((removed + 1))
    fi
  done <<< "$rows"

  echo
  if [ "$remove" -eq 1 ]; then
    echo "removed $removed worktree(s), kept $kept"
    git -C "$repo" worktree prune
  else
    echo "$removed removable, $kept kept. Re-run with --remove to apply."
  fi
  return 0
}

case "${1:-}" in
  acquire) shift; cmd_acquire "$@" ;;
  claim) shift; cmd_claim "$@" ;;
  list) cmd_list ;;
  claims) shift; cmd_claims "$@" ;;
  mine) cmd_mine ;;
  send) shift; cmd_send "$@" ;;
  ask) shift; cmd_ask "$@" ;;
  dispatch) shift; cmd_dispatch "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  read) shift; cmd_read "$@" ;;
  status) shift; cmd_status "$@" ;;
  repo) shift; cmd_repo "$@" ;;
  closeout) shift; cmd_closeout "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  stop-all) shift; cmd_stop_all "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  sweep) shift; cmd_sweep "$@" ;;
  boundary) shift; cmd_boundary "$@" ;;
  fences) shift; [ "$#" -eq 0 ] || die "usage: $0 fences"; cmd_fences ;;
  gate) shift; [ "$#" -eq 0 ] || die "usage: $0 gate"; cmd_gate ;;
  verify-sha) shift; cmd_verify_sha "$@" ;;
  sync-main) shift; cmd_sync_main "$@" ;;
  *) die "usage: $0 {acquire|claim|list|claims|mine|send|ask|dispatch|wait|read|status|repo|closeout|stop|stop-all|doctor|sweep|boundary|fences|gate|verify-sha|sync-main}" ;;
esac
