#!/bin/bash
# Left-hand tab list for the "main" tmux session, rendered with fzf as a
# pure display (no input line, no key/mouse handling). Clicks are handled
# by the outer tmux (ui.conf → sidebar-click.sh); refreshes arrive over the
# unix socket from tmux hooks (sidebar-refresh.sh). Never polls.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX   # always address the default ("main") server, not the outer ui one

SOCK="${TMPDIR:-/tmp}/tmux-sidebar-$UID.sock"
LIST="$HOME/.config/tmux/sidebar-list.sh"
CACHE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.rows"   # rows currently shown; refresh/pos/click read it

rm -f "$SOCK"
while :; do
  # If main is gone, wait for it to come back.
  if ! tmux has-session -t main 2>/dev/null; then sleep 1; continue; fi
  # Drop the previous socket before EVERY launch, not just the first one.
  # fzf unlinks its socket on a clean exit, but not when it is killed -- and a
  # leftover file makes the next `--listen` bind fail. When that happened the
  # old fzf had already created the path and a dying one unlinked it out from
  # under the new process, so the sidebar kept rendering while its socket was
  # unreachable: every refresh silently no-op'd and the ▶ stopped tracking the
  # active tab, even though clicking still switched tabs.
  rm -f "$SOCK"
  "$LIST" | tee "$CACHE" | fzf \
    --listen="$SOCK" \
    --no-input --layout=reverse --no-info --no-separator --no-scrollbar \
    --delimiter='\t' --with-nth=2 \
    --pointer='' --marker='' --header=$'  TABS\n ' --header-first --margin=2,1,0,2 --gap=1 --gap-line=' ' \
    --color='fg:-1,bg:-1,fg+:#ffffff:bold,bg+:#0969da,hl:-1,hl+:#ffffff,header:8,gutter:-1' \
    --no-mouse --cycle --no-clear --ansi \
    --bind "load:transform($HOME/.config/tmux/sidebar-pos.sh)" \
    >/dev/null
  sleep 0.2
done
