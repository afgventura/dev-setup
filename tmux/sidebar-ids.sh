#!/bin/bash
# Record (or print) which pane of the outer "ui" window is the sidebar and
# which is the content pane:
#   sidebar-ids.sh        print "<sidebar> <content>"
#   sidebar-ids.sh set    write @sidebar / @content
#
# Nothing *requires* these options any more: ui.conf identifies the sidebar by
# geometry (pane_left 0), so a stale or empty id can no longer send a sidebar
# click down the wrong branch. They are kept because the scripts and humans read
# them, and because the ids must be re-recorded whenever the layout is (re)built
# -- the values are not otherwise derivable from a plain `tmux show-options`.
#
# What went wrong before: ui.conf opened with `set -g @sidebar ""` /
# `set -g @content ""`, so every reload of the config (install.sh does exactly
# that: `tmux -L ui source-file ui.conf`) blanked both ids. Every guard in
# ui.conf compared `#{pane_id}` against them, so after a reload a left click in
# the sidebar fell through to the "else" branch -- `select-pane -t =` -- and put
# the keyboard on the fzf pane, whose `--no-input` silently swallows every
# keystroke (clicks still rendered, so the sidebar looked fine while the whole
# UI was dead; clicking the content pane brought it back).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec 2>/dev/null
TMUX_BIN=/opt/homebrew/bin/tmux

# Leftmost pane = sidebar, the other one = content. Exit quietly if the layout
# is not built yet (a fresh server sources ui.conf before the split happens) or
# is not the expected shape; the caller must treat that as "leave things alone".
read -r sidebar content < <(
  "$TMUX_BIN" -L ui list-panes -t ui -F '#{pane_id} #{pane_left}' |
    awk '$2 == 0 && !s { s = $1 } $2 != 0 && !c { c = $1 } END { print s, c }'
)
[ -n "$sidebar" ] && [ -n "$content" ] || exit 1

if [ "${1:-}" = set ]; then
  "$TMUX_BIN" -L ui set -g @sidebar "$sidebar"
  "$TMUX_BIN" -L ui set -g @content "$content"
else
  printf '%s %s\n' "$sidebar" "$content"
fi
exit 0
