#!/usr/bin/env bash
# Outer-tmux mouse handler: a left click at row $1 of the sidebar pane.
# Row 0 is the "TABS" header; other rows come from sidebar-list.sh, whose
# first field is the target: "@id" = tab in main, "" = group header (no-op).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
y=${1:-0}
[ "$y" -ge 1 ] 2>/dev/null || exit 0
target=$("$HOME/.config/tmux/sidebar-list.sh" | sed -n "${y}p" | cut -f1)
case "$target" in
  @*) for c in $(tmux list-clients -F '#{client_tty}'); do tmux switch-client -c "$c" -t "main:$target"; done ;;
  *)  exit 0 ;;
esac
"$HOME/.config/tmux/sidebar-refresh.sh"   # switch-client fires no select-window hook
