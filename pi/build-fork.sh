#!/usr/bin/env bash
# Build the custom pi fork (afgventura/pi) and install it as the global `pi`.
#
# Why run the fork instead of npm's @earendil-works/pi-coding-agent: npm 1.0.0 lays out the whole
# transcript on every frame, so a long session costs the entire history per keystroke or streamed
# token (measured: 5,986 messages -> 1.5M lines -> 81 ms/frame warm, 17 s for the first render).
# The fork adds a transcript window (`transcriptMaxLines`, default 20000) that drops the oldest
# items, which bounds a frame by the window instead. It also carries local commits npm's build
# does not have (`set_cwd`, backgrounded long shell commands, indexed session picker,
# `quietExtensionWarnings`). Verify step below fails loudly if a build loses any of this.
#
# Overridable:
#   PI_FORK_REF    git ref to build                (default: perf/transcript-window)
#   PI_FORK_DIR    worktree to clone/update        (default: $HOME/Workspace/pi)
#   PI_BIN         where the built bundle is linked (default: /usr/local/bin/pi)
#   PI_FORK_STAGE  carry a Mac working tree from here, if present (default: /tmp/pi-stage)
#   SKIP_LINK=1    build only, leave the global `pi` alone
set -euo pipefail

REF="${PI_FORK_REF:-perf/transcript-window}"
DIR="${PI_FORK_DIR:-$HOME/Workspace/pi}"
BIN="${PI_BIN:-/usr/local/bin/pi}"
STAGE="${PI_FORK_STAGE:-/tmp/pi-stage}"
REPO_URL="https://github.com/afgventura/pi.git"
BUNDLE="$DIR/packages/coding-agent/dist/bundle/cli.js"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

# The cmx wrapper (/opt/cmx/agents/pi -> run) is shared by every agent CLI on the box; replacing it
# breaks all of them. It forwards to /usr/local/bin/pi, so link there instead.
case "$BIN" in /opt/cmx/*) die "refusing to replace $BIN: shared agent multiplexer, link /usr/local/bin/pi instead" ;; esac

say "fork worktree: $DIR (ref $REF)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin --tags --quiet
  # Carry the Mac's working tree, if it was staged. Without a stage dir the ref alone must build.
  if [ -n "$(git -C "$DIR" status --porcelain)" ] && [ ! -d "$STAGE" ]; then
    die "$DIR has uncommitted changes and no $STAGE to explain them; commit or stash them first"
  fi
else
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO_URL" "$DIR"
fi

# Prefer a local branch (the dev machine, which may be ahead of origin); fall back to origin (fresh clone).
if git -C "$DIR" show-ref --verify --quiet "refs/heads/$REF"; then
  git -C "$DIR" checkout -q "$REF"
  RESOLVED="$REF"
elif git -C "$DIR" rev-parse --verify --quiet "origin/$REF" >/dev/null; then
  git -C "$DIR" checkout -q -B "$REF" "origin/$REF"
  RESOLVED="origin/$REF"
elif git -C "$DIR" rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
  git -C "$DIR" checkout -q --detach "$REF"
  RESOLVED="$REF"
else
  die "ref $REF not found in $DIR (tried refs/heads/$REF, origin/$REF, and $REF as a commit)"
fi
echo "   at $(git -C "$DIR" rev-parse --short HEAD) from $RESOLVED ($(git -C "$DIR" log -1 --format=%s | cut -c1-55))"

if [ -d "$STAGE" ]; then
  say "carrying the staged working tree from $STAGE"
  [ -f "$STAGE/npmrc" ] && cp "$STAGE/npmrc" "$DIR/.npmrc"
  if [ -f "$STAGE/wip.patch" ]; then
    if git -C "$DIR" apply -3 "$STAGE/wip.patch" 2>&1 | tail -5; then echo "   patch ok"; else warn "patch conflicts"; fi
  fi
  [ -f "$STAGE/untracked.tgz" ] && tar xzf "$STAGE/untracked.tgz" -C "$DIR"
  echo "   changed entries: $(git -C "$DIR" status --porcelain | wc -l)"
fi

say "npm install (workspaces)"
# --ignore-scripts per the repo's own rule; HUSKY=0 because a pre-commit hook is not wanted here.
( cd "$DIR" && HUSKY=0 npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -5 )

say "npm run build"
( cd "$DIR" && npm run build 2>&1 | tail -15 )

[ -f "$BUNDLE" ] || die "build produced no bundle at $BUNDLE"

say "verify the build actually is the fork"
CHUNKS="$(dirname "$BUNDLE")/chunks"
for marker in transcriptMaxLines quietExtensionWarnings set_cwd; do
  grep -rq "$marker" "$CHUNKS" || die "built bundle has no '$marker': this is not the fork build, refusing to install"
  echo "   ok: $marker"
done

if [ "${SKIP_LINK:-0}" = 1 ]; then
  say "SKIP_LINK=1 — built $BUNDLE, left the global pi alone"
  exit 0
fi

say "install as $BIN"
BEFORE="$(command -v pi 2>/dev/null || true)"
[ -n "$BEFORE" ] && echo "   pi on PATH: $BEFORE -> $(readlink -f "$BEFORE")"
if [ -e "$BIN" ] && [ ! -L "$BIN" ]; then
  mv "$BIN" "$BIN.bak-$(date +%Y%m%d%H%M%S)"
fi
ln -sfn "$BUNDLE" "$BIN"

LINKED="$(readlink -f "$BIN")"
echo "   $BIN -> $LINKED"
echo "   version: $("$BIN" --version)"
[ "$LINKED" = "$BUNDLE" ] || die "$BIN does not resolve to the build ($LINKED)"

# On cmx the first pi on PATH is /opt/cmx/agents/pi, a wrapper that forwards to
# /usr/local/bin/pi at runtime, so it legitimately differs from $BIN. Check the wrapper's text for
# that forward rather than guess from its resolved path.
FIRST="$(command -v pi 2>/dev/null || true)"
if [ -n "$FIRST" ] && [ "$FIRST" != "$BIN" ]; then
  FIRST_REAL="$(readlink -f "$FIRST")"
  echo "   note: first pi on PATH is $FIRST ($FIRST_REAL)"
  if [ "$FIRST_REAL" = "$BUNDLE" ] || [ "$FIRST_REAL" = "$BIN" ]; then
    echo "         ...that is $BIN"
  elif grep -qsF "/usr/local/bin/" "$FIRST_REAL"; then
    echo "         ...a wrapper that forwards into /usr/local/bin, so $BIN is what runs"
  else
    warn "...which does not forward to $BIN. Check: which -a pi, then set PI_BIN= or fix PATH"
  fi
fi

say "revert with: ln -sfn ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js $BIN"
say "PI_BUILD_DONE"
