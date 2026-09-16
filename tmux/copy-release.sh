#!/usr/bin/env bash
# Mouse-drag release in copy mode. tmux ends a mouse selection *before* the
# cell under the cursor (it draws that cell in the cursor colour but does not
# copy it), so dragging to the last character of a URL copied all but that
# character. Include the cursor cell when it holds a non-blank character —
# what a native terminal selection does — then copy and leave copy mode.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec 2>/dev/null
p=$1
x=$(tmux display -p -t "$p" '#{copy_cursor_x}')
line=$(tmux display -p -t "$p" '#{copy_cursor_line}')
c=${line:$x:1}
if [ -n "$c" ] && [ "$c" != " " ]; then tmux send-keys -t "$p" -X cursor-right; fi
tmux send-keys -t "$p" -X copy-pipe-and-cancel
