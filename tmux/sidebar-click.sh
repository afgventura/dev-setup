#!/usr/bin/env bash
# Outer-tmux mouse handler: a left click at row $1 of the sidebar pane.
# Screen rows 0-1 are fzf's top margin, 2-3 the "TABS" header (+ blank line);
# the rest come from sidebar-list.sh, whose
# first field is the target: "@id" = tab in main, "" = group header (no-op).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
exec 2>/dev/null   # never let a stray error reach tmux/fzf output
y=$(( ${1:-0} - 3 ))   # screen row → list row (2 margin + 2 header rows above)
[ "$y" -ge 1 ] 2>/dev/null || exit 0
CACHE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.rows"   # what the sidebar is showing right now
[ -s "$CACHE" ] || "$HOME/.config/tmux/sidebar-list.sh" > "$CACHE"
target=$(sed -n "${y}p" "$CACHE" | cut -f1)
case "$target" in
  @*) for c in $(tmux list-clients -F '#{client_tty}'); do tmux switch-client -c "$c" -t "main:$target"; done ;;
  *)  exit 0 ;;
esac
"$HOME/.config/tmux/sidebar-refresh.sh"   # switch-client fires no select-window hook
