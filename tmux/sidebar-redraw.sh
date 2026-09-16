#!/usr/bin/env bash
# Repaint the sidebar after the Ghostty window is resized or regains focus
# (switching macOS Spaces does both). The tab list sometimes came back blank
# — only the TABS header — until the next reload; fzf had been resized twice
# in quick succession (the window resize, then our resize-pane back to 51
# columns) and didn't repaint the rows. Once things settle: redraw the whole
# client from tmux's screen, then make fzf re-render its list from the cache.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec 2>/dev/null
SOCK="${TMPDIR:-/tmp}/tmux-sidebar-$UID.sock"
CACHE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.rows"
POS="${TMPDIR:-/tmp}/tmux-sidebar-$UID.pos"
LOCK="${TMPDIR:-/tmp}/tmux-sidebar-$UID.redraw"
mkdir "$LOCK" 2>/dev/null || exit 0     # one pending repaint is enough
sleep 0.4
rmdir "$LOCK" 2>/dev/null
tmux -L ui refresh-client >/dev/null 2>&1
[ -S "$SOCK" ] && [ -s "$CACHE" ] || exit 0
curl -s --max-time 2 --unix-socket "$SOCK" -X POST http://localhost/ -d "reload-sync(cat $CACHE)+$(cat "$POS" 2>/dev/null || echo 'pos(1)')" >/dev/null 2>&1
exit 0
