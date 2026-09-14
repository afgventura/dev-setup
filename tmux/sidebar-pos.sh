#!/usr/bin/env bash
# fzf `transform` helper: prints the action that moves the cursor to the row
# of what the nested client is looking at (active tab, or a peeked session).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
cur=$(tmux list-clients -F '#{client_session}' 2>/dev/null | head -1); cur=${cur:-main}
if [ "$cur" = main ]; then want="$(tmux display -t main -p '#{window_id}' 2>/dev/null)"; else want="sess:$cur"; fi
n=$("$HOME/.config/tmux/sidebar-list.sh" | cut -f1 | grep -n -x -F -- "$want" | head -1 | cut -d: -f1)
echo "pos(${n:-1})"
