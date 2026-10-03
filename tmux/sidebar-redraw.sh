#!/bin/bash
# Repaint the sidebar after the Ghostty window is resized or regains focus
# (switching macOS Spaces does both), and reassert the layout on the way in:
#   * put the sidebar back to @sidebar_width,
#   * re-record @sidebar/@content from the live panes,
#   * redraw the whole client from tmux's screen, then make fzf re-render its
#     list from the cache.
# Called from ui.conf's client-attached / client-resized / client-focus-in hooks.
#
# Why the layout work lives here: the tab list sometimes came back blank -- only
# the TABS header -- until the next reload, because fzf had been resized twice in
# quick succession (the window resize, then our resize-pane back to width) and
# didn't repaint the rows; doing both in one place, once things have settled,
# is the fix. And the width used to be enforced by an inline hook in ui.conf
# whose `[ -n "$s" ]` tmux expanded to `[ -n "" ]` while parsing the config, so
# it had never resized anything -- the pane kept whatever width the split got.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec 2>/dev/null
TMUX_BIN=/opt/homebrew/bin/tmux
IDS="$HOME/.config/tmux/sidebar-ids.sh"
SOCK="${TMPDIR:-/tmp}/tmux-sidebar-$UID.sock"
CACHE="${TMPDIR:-/tmp}/tmux-sidebar-$UID.rows"
POS="${TMPDIR:-/tmp}/tmux-sidebar-$UID.pos"
LOCK="${TMPDIR:-/tmp}/tmux-sidebar-$UID.redraw"
mkdir "$LOCK" 2>/dev/null || exit 0     # one pending repaint is enough
sleep 0.4
rmdir "$LOCK" 2>/dev/null

# The sidebar pane comes straight from the layout -- the same geometry rule the
# guards in ui.conf use -- so a missing helper can never leave the layout
# unrepaired. sidebar-ids.sh only *records* the ids (for scripts and humans).
read -r sidebar content < <(
  "$TMUX_BIN" -L ui list-panes -t ui -F '#{pane_id} #{pane_left}' |
    awk '$2 == 0 && !s { s = $1 } $2 != 0 && !c { c = $1 } END { print s, c }'
)
[ -n "$sidebar" ] && [ -n "$content" ] && [ -x "$IDS" ] && "$IDS" set >/dev/null 2>&1
# Both panes must be there before touching the width: with the sidebar gone the
# content pane is the only pane and also sits at column 0, and resizing "the
# sidebar" would then shrink the user's terminal to the sidebar width.
if [ -n "$sidebar" ] && [ -n "$content" ]; then
  # @sidebar_width is the single knob (ui.conf). Clamp so a narrow window keeps
  # at least ~40 columns for the content instead of letting the sidebar win.
  want=$("$TMUX_BIN" -L ui show-options -gv @sidebar_width)
  case "$want" in '' | *[!0-9]*) want=72 ;; esac
  win=$("$TMUX_BIN" -L ui display -p -t ui '#{window_width}')
  case "$win" in '' | *[!0-9]*) win=0 ;; esac
  [ "$win" -gt 0 ] && [ "$want" -gt $((win - 40)) ] && want=$((win - 40))
  [ "$want" -lt 24 ] && want=24
  have=$("$TMUX_BIN" -L ui display -p -t "$sidebar" '#{pane_width}')
  [ "$have" = "$want" ] || "$TMUX_BIN" -L ui resize-pane -t "$sidebar" -x "$want" >/dev/null 2>&1
fi

"$TMUX_BIN" -L ui refresh-client >/dev/null 2>&1
[ -S "$SOCK" ] && [ -s "$CACHE" ] || exit 0
curl -s --max-time 2 --unix-socket "$SOCK" -X POST http://localhost/ -d "reload-sync(cat $CACHE)+$(cat "$POS" 2>/dev/null || echo 'pos(1)')" >/dev/null 2>&1
exit 0
