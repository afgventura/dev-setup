#!/bin/bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec 2>/dev/null   # any output or non-zero exit makes tmux pop a "returned N" view in the user's pane
unset TMUX   # always address the default ("main") server, not the outer ui one
# Called from tmux hooks in ~/.tmux.conf: tells the sidebar fzf to reload
# its list and move the cursor to the active tab. No-op if no sidebar.
#
# Hooks fire in bursts (every agent's title spinner is a pane-title-changed),
# and fzf runs reload-sync requests one after another, so without coalescing
# a tab switch queues behind dozens of stale reloads and the ▶ lags. Here the
# first caller holds a lock and reloads while a "dirty" flag keeps being set;
# every other caller just sets the flag and exits.
SOCK="${TMPDIR:-/tmp}/tmux-sidebar-$UID.sock"
if [ ! -S "$SOCK" ]; then
  # fzf can outlive its own listen socket (it is killed, or a stale socket file
  # blocked a respawn's bind). The sidebar keeps rendering, so nothing looks
  # broken -- but every refresh past this point is a silent no-op and the ▶
  # stops following the active tab while clicks still switch tabs. Kill the
  # orphaned fzf; sidebar.sh's loop respawns it and re-creates the socket.
  pkill -f "fzf --listen=$SOCK" 2>/dev/null
  exit 0
fi
LIST="$HOME/.config/tmux/sidebar-list.sh"
CACHE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.rows"     # last rows sent to fzf (sidebar-pos.sh reads it too)
POS="${TMPDIR:-/tmp}/tmux-sidebar-$UID.pos"        # "pos(N)" for the active tab in $CACHE (fzf's load handler cats it)
LOCK="${TMPDIR:-/tmp}/tmux-sidebar-$UID.lock"
DIRTY="${TMPDIR:-/tmp}/tmux-sidebar-$UID.dirty"
refresh() {  # only bother fzf when the rows actually changed
  local new n=0 i=0 line
  new=$("$LIST")
  # An empty list means `tmux list-windows` failed (server busy/locked for a
  # moment), not that there are no tabs. Publishing it blanked the sidebar
  # and broke next/prev (they navigate the cached rows) until the next real
  # change. Retry once, then keep what we have.
  if [ -z "$new" ]; then sleep 0.1; new=$("$LIST"); [ -n "$new" ] || return 0; fi
  [ "$new" = "$(<"$CACHE")" ] && return 0
  # cursor row = the line whose target is the active window (marker "▶" in the
  # display column). Computed here, in bash, so fzf can be told the position in
  # the same request as the reload instead of shelling out again on `load`.
  while IFS= read -r line; do
    i=$((i + 1))
    case "$line" in *$'\t  ▶ '*) n=$i; break ;; esac
  done <<< "$new"
  [ "$n" -gt 0 ] || n=1
  printf '%s\n' "$new" > "$CACHE.tmp" && mv -f "$CACHE.tmp" "$CACHE"
  printf 'pos(%d)\n' "$n" > "$POS"
  curl -s --max-time 2 --unix-socket "$SOCK" -X POST http://localhost/ -d "reload-sync(cat $CACHE)+pos($n)" >/dev/null 2>&1
}

SETTLE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.settle"

touch "$DIRTY"
# a lock left behind by a killed run must not wedge the sidebar forever.
# NB: EPOCHSECONDS is bash 5+ only, and tmux invokes this script under
# /bin/bash 3.2 (its server PATH has no /opt/homebrew/bin), where it is empty
# -- which made `age` a large negative number, so this guard never fired.
if [ -d "$LOCK" ]; then
  now=$(date +%s)
  age=$(( now - $(stat -f %m "$LOCK" 2>/dev/null || echo "$now") ))   # fallback if it vanished under us
  [ "$age" -gt 5 ] && rmdir "$LOCK" 2>/dev/null
fi
while :; do
  mkdir "$LOCK" 2>/dev/null || exit 0        # someone else is refreshing; they'll see the flag
  # tmux applies automatic-rename on a short timer; one deferred pass catches
  # the settled name (only the lock holder schedules it, and only one at a time)
  if [ "${1:-}" != settle ] && mkdir "$SETTLE" 2>/dev/null; then
    ( sleep 0.8; rmdir "$SETTLE" 2>/dev/null; exec "$0" settle ) &
  fi
  while [ -e "$DIRTY" ]; do
    rm -f "$DIRTY"; refresh
    [ -e "$DIRTY" ] && sleep 0.1   # flag set again while we reloaded → a storm; throttle to ≤10/s
  done
  rmdir "$LOCK" 2>/dev/null
  [ -e "$DIRTY" ] || exit 0                  # flag set between the loop and the unlock → go again
done
