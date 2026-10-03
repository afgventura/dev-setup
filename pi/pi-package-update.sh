#!/bin/bash
# Keep pi's extension packages current, so the "Package Updates Available"
# banner stops appearing in every session. launchd runs this at login and every
# 12 h (com.gery.pi-package-update).
#
# Scope is `pi update --extensions`, never a plain `pi update`: self-updating pi
# REINSTALLS the package and drops the `quietExtensionWarnings` patch that
# install.sh applies (see README > pi). Extensions are separate npm packages, so
# updating them cannot touch that patch.
#
# Version ranges still move. pi treats only an exact version as fixed
# (`isExactNpmVersion`, and both the update and the update check skip those), so
# `npm:pi-mcp-adapter@^5.0.0` takes the newest 5.x by itself -- which is what the
# pin is for -- and an exact `@5.0.0` would be left alone.
#
# The banner is fed by a cached check, ~/.pi/agent/package-update-check.json,
# which pi refreshes only once a day. Updating packages without clearing it
# leaves the banner naming packages that are already current (that is exactly
# the state this daemon was written in: the cache still named a package that had
# just been updated). So after a successful run, a cache that lists updates is
# removed; the next session re-checks, finds nothing and stays quiet. Only a
# cache with a non-empty `updates` array is touched, so an up-to-date cache
# keeps saving the ~2.9 s check at startup.
#
# Working directory is a scratch dir, NOT $HOME: from $HOME, ~/.pi/settings.json
# is read as *project* settings (~/.pi doubles as $HOME/.pi), so the run would
# see project-scope packages and could demand --approve.
#
# A session that is already running keeps the extension code it loaded at
# startup. One that starts inside the ~7 s npm rewrite can catch a half-written
# package and warn once; the next start is clean. The lock keeps two updaters
# from overlapping, and a lock left behind by a killed run expires.
#
# Log: ~/.local/state/pi-package-update.log, and only when something changed or
# failed. A log that says "nothing to do" twice a day is a log nobody reads.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG="$HOME/.local/state/pi-package-update.log"
CWD="$HOME/.local/state/pi-package-update/cwd"
CHECK="$HOME/.pi/agent/package-update-check.json"
LOCK="${TMPDIR:-/tmp}/pi-package-update-$UID.lock"
MAX_LOG=$((256 * 1024))     # rotate rather than grow without bound

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# launchd's PATH carries no nvm, and pi lives under one node version there: take
# the newest installed nvm node that actually has pi, then any pi on PATH.
find_pi() {
  local ver p
  if [ -n "${PI_BIN:-}" ] && [ -x "${PI_BIN}" ]; then printf '%s\n' "$PI_BIN"; return 0; fi
  for ver in $(ls "$HOME/.nvm/versions/node" 2>/dev/null | sed 's/^v//' |
    sort -t. -k1,1n -k2,2n -k3,3n -r); do
    p="$HOME/.nvm/versions/node/v$ver/bin/pi"
    if [ -x "$p" ]; then printf '%s\n' "$p"; return 0; fi
  done
  p=$(command -v pi 2>/dev/null)
  if [ -x "$p" ]; then printf '%s\n' "$p"; return 0; fi
  return 1
}

mkdir -p "$(dirname "$LOG")" "$CWD"

# one updater at a time; a lock from a killed run must not wedge the job forever
if ! mkdir "$LOCK" 2>/dev/null; then
  now=$(date +%s)
  age=$((now - $(stat -f %m "$LOCK" 2>/dev/null || echo "$now")))
  [ "$age" -gt 1800 ] && rmdir "$LOCK" 2>/dev/null
  # Say so: a silently skipped run is indistinguishable from a run that did
  # nothing, and the interesting case (a run killed by `launchctl kickstart -k`
  # leaving its lock behind) then looks like the daemon is broken.
  mkdir "$LOCK" 2>/dev/null || { log "skipped: another run holds $LOCK (${age}s old)"; exit 0; }
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG" ]; then
  mv -f "$LOG" "$LOG.1"
fi

PI=$(find_pi) || { log "FAILED: no pi binary found (set PI_BIN)"; exit 0; }
# pi's launcher is a `#!/usr/bin/env node` shim and its node lives next to it
# (nvm's bin dir is not in launchd's PATH, and the PATH above deliberately has no
# node), so without this every run dies as "env: node: No such file or directory".
PATH="$(dirname "$PI"):$PATH"
cd "$CWD" || exit 0

# timeout(1) puts the child in its own process group and kills the group, so a
# hung npm cannot leave an orphan behind.
run=("$PI" update --extensions)
command -v timeout >/dev/null 2>&1 && run=(timeout -k 10 600 "$PI" update --extensions)
out=$("${run[@]}" 2>&1)
st=$?

changed=$(printf '%s\n' "$out" | grep -oE 'changed [1-9][0-9]* packages?' | head -1)
if [ "$st" -ne 0 ]; then
  log "FAILED (exit $st, $PI): $(printf '%s\n' "$out" | grep -vE '^ *$' | tail -4 | tr '\n' ' ')"
  exit 0
fi
[ -n "$changed" ] && log "updated packages ($changed) with $PI"

# the banner reads this cache; drop it only when it would actually say something
if grep -q '"updates":\[[^]]' "$CHECK" 2>/dev/null; then
  rm -f "$CHECK"
  [ -n "$changed" ] || log "cleared the stale package-update check cache"
fi
exit 0
