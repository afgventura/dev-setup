#!/usr/bin/env bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX   # always address the default ("main") server, not the outer ui one
# Called from tmux hooks in ~/.tmux.conf: tells the sidebar fzf to reload
# its list and move the cursor to the active tab. No-op if no sidebar.
SOCK="${TMPDIR:-/tmp}/tmux-sidebar-$UID.sock"
[ -S "$SOCK" ] || exit 0
# shellcheck disable=SC2016
LIST='tmux list-windows -t main -F "#{window_index}	#{?window_active,▶,#{?window_activity_flag,•, }} #{p48:#{=48:window_name}}" 2>/dev/null'
# cursor placement happens in fzf's own `load` handler (sidebar-pos.sh)
refresh() { curl -s --unix-socket "$SOCK" -X POST http://localhost/ -d "reload-sync($LIST)" >/dev/null 2>&1; }
refresh
# tmux applies automatic-rename on a short timer; catch the settled name too
( sleep 0.8; refresh ) &
