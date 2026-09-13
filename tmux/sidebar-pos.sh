#!/usr/bin/env bash
# fzf `transform` helper: prints the action that moves the cursor to the
# active tab's row. Run by fzf on every `load` (initial list and reloads).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
n=$(tmux list-windows -t main -F '#{window_active}' 2>/dev/null | grep -n 1 | head -1 | cut -d: -f1)
echo "pos(${n:-1})"
