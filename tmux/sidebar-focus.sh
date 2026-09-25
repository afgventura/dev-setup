#!/bin/bash
# Move keyboard focus off the sidebar and onto the real content pane.
#
# The sidebar is `fzf --no-input`: if it ever keeps focus it silently swallows
# every keystroke and the whole UI looks frozen (nothing repaints, typing does
# nothing) even though tmux and macOS are perfectly healthy. ui.conf therefore
# calls this from pane-focus-in / after-select-pane.
#
# ui.conf cannot do the redirect inline: `if-shell -F` expands formats in its
# *condition* but NOT in its command argument, so `select-pane -t #{@content}`
# arrives with an empty target ("command select-pane: -t expects an argument").
# Resolving the id here, in the shell, is the reliable route.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec 2>/dev/null
TMUX_BIN=/opt/homebrew/bin/tmux

content=$("$TMUX_BIN" -L ui show-options -gv @content)
[ -n "$content" ] || exit 0          # ui server gone / ids not recorded yet
"$TMUX_BIN" -L ui select-pane -t "$content"
exit 0
