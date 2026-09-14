#!/usr/bin/env bash
# fzf `transform` helper: prints the action that moves the cursor to the
# active tab's row.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
exec 2>/dev/null   # never let a stray error reach tmux/fzf output
want="$(tmux display -t main -p '#{window_id}' 2>/dev/null)"
CACHE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.rows"   # the rows fzf just loaded (written by sidebar-refresh.sh)
[ -s "$CACHE" ] || "$HOME/.config/tmux/sidebar-list.sh" > "$CACHE"
n=$(cut -f1 "$CACHE" | grep -n -x -F -- "$want" | head -1 | cut -d: -f1)
echo "pos(${n:-1})"
