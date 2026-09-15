#!/usr/bin/env bash
# fzf `transform` helper: prints the action that moves the cursor to the
# active tab's row. Normally sidebar-refresh.sh has already computed this for
# the rows it just sent (and sent it in the same request); this only has to
# work it out itself on the first load, when the rows came from sidebar.sh.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
exec 2>/dev/null   # never let a stray error reach tmux/fzf output
CACHE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.rows"   # the rows fzf just loaded
POS="${TMPDIR:-/tmp}/tmux-sidebar-$UID.pos"
if [ -s "$POS" ] && [ ! "$CACHE" -nt "$POS" ]; then cat "$POS"; exit 0; fi
want="$(tmux display -t main -p '#{window_id}' 2>/dev/null)"
[ -s "$CACHE" ] || "$HOME/.config/tmux/sidebar-list.sh" > "$CACHE"
n=$(cut -f1 "$CACHE" | grep -n -x -F -- "$want" | head -1 | cut -d: -f1)
echo "pos(${n:-1})"
