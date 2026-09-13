#!/usr/bin/env bash
# Outer-tmux mouse handler: a left click at row $1 of the sidebar pane
# switches "main" to the tab on that row. Row 0 is the "TABS" header.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
y=${1:-0}
[ "$y" -ge 1 ] 2>/dev/null || exit 0
idx=$(tmux list-windows -t main -F '#{window_index}' 2>/dev/null | sed -n "${y}p")
[ -n "$idx" ] || exit 0
tmux select-window -t "main:$idx"
