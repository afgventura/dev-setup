#!/usr/bin/env bash
# ⌘⇧U: pick a URL from the current pane's visible text (+ recent scrollback)
# and open it. Ghostty can't do ⌘-click link detection while tmux has the
# mouse (only ⇧⌘-click works), so this is the keyboard route.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
urls=$(tmux capture-pane -p -J -S -200 -t "${1:-}" 2>/dev/null \
  | grep -oE '(https?://|file://)[^[:space:]"'"'"'<>)\]]+' | sed 's/[.,;:]*$//' | awk '!seen[$0]++' | tail -r)
[ -n "$urls" ] || { tmux display-message "no URLs in this pane"; exit 0; }
if [ "$(printf '%s\n' "$urls" | wc -l)" -eq 1 ]; then open "$urls"; exit 0; fi
pick=$(printf '%s\n' "$urls" | fzf --no-multi --layout=reverse --no-info --prompt='open ▸ ' \
  --header='↑↓ choose · Enter open · Esc cancel' --color='fg:-1,bg:-1,fg+:#ffffff:bold,bg+:#0969da,hl:-1,hl+:#ffffff,header:8,prompt:4,gutter:-1')
[ -n "$pick" ] && open "$pick"
exit 0
