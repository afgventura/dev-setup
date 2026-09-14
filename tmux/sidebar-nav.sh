#!/usr/bin/env bash
# ⌘⇧] / ⌘⇧[ : next / previous tab IN SIDEBAR ORDER (grouped by folder), not
# tmux's window-index order, which would jump around between groups.
#   sidebar-nav.sh next|prev
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec 2>/dev/null
unset TMUX
CACHE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.rows"
[ -s "$CACHE" ] || "$HOME/.config/tmux/sidebar-list.sh" > "$CACHE"
cur=$(tmux display -t main -p '#{window_id}')
# targets only (skip group headers), in display order
ids=$(cut -f1 "$CACHE" | grep '^@')
[ -n "$ids" ] || exit 0
n=$(printf '%s\n' "$ids" | grep -n -x -F -- "$cur" | head -1 | cut -d: -f1)
total=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
case "${1:-next}" in
  next) i=$(( n % total + 1 )) ;;
  prev) i=$(( (n + total - 2) % total + 1 )) ;;
esac
target=$(printf '%s\n' "$ids" | sed -n "${i}p")
[ -n "$target" ] && tmux select-window -t "main:$target"
exit 0
