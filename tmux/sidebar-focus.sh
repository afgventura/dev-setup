#!/bin/bash
# Move keyboard focus off the sidebar and onto the real content pane.
#
# The sidebar is `fzf --no-input`: if it ever keeps focus it silently swallows
# every keystroke and the whole UI looks frozen (nothing repaints, typing does
# nothing) even though tmux and macOS are perfectly healthy. ui.conf therefore
# calls this from pane-focus-in / after-select-pane, both guarded by the
# sidebar's geometry (it is the pane at column 0) rather than by a recorded id.
#
# ui.conf cannot do the redirect inline: `if-shell -F` expands formats in its
# *condition* but NOT in its command argument, so `select-pane -t #{@content}`
# arrives with an empty target ("command select-pane: -t expects an argument").
# Resolving the id here, in the shell, is the reliable route.
#
# The destination is derived from the live layout on purpose. Reading
# @content made this recovery path depend on an option that ui.conf used to
# blank on every load (install.sh re-sources ui.conf into the live server), so
# the one script whose job is to never strand the keyboard could itself be
# disabled by a config reload.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec 2>/dev/null
TMUX_BIN=/opt/homebrew/bin/tmux

# The content pane is the one that is not at column 0 (there are only two).
content=$("$TMUX_BIN" -L ui list-panes -t ui -F '#{pane_id} #{pane_left}' |
  awk '$2 != 0 { print $1; exit }')
[ -n "$content" ] || content=$("$TMUX_BIN" -L ui show-options -gv @content)
[ -n "$content" ] || exit 0          # ui server gone / layout not built yet
"$TMUX_BIN" -L ui select-pane -t "$content"
exit 0
