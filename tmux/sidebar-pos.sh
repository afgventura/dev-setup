#!/usr/bin/env bash
# fzf `transform` helper: prints the action that moves the cursor to the
# active tab's row.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
want="$(tmux display -t main -p '#{window_id}' 2>/dev/null)"
n=$("$HOME/.config/tmux/sidebar-list.sh" | cut -f1 | grep -n -x -F -- "$want" | head -1 | cut -d: -f1)
echo "pos(${n:-1})"
