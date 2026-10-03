#!/bin/bash
# Ghostty's `command`. Layout:
#   ┌────────┬──────────────────────────┐
#   │ TABS   │  tmux session "main"     │
#   │ (fzf)  │  (your real shell/agents)│
#   └────────┴──────────────────────────┘
# "main" survives Ghostty being closed; "ui" is throwaway chrome.
set -u
TMUX_BIN=/opt/homebrew/bin/tmux
CFG="$HOME/.config/tmux"
DEFAULT_SIDEBAR_WIDTH=72

# Real session (persistent).
"$TMUX_BIN" has-session -t main 2>/dev/null || "$TMUX_BIN" new-session -d -s main -c "$HOME"

# Chrome session (rebuilt if missing).
if ! "$TMUX_BIN" -L ui has-session -t ui 2>/dev/null; then
  # size the detached session to the real terminal so the 26-col split is exact
  ROWS=0; COLS=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do   # the pty can report 0x0 for a moment at launch
    read -r ROWS COLS < <(stty size 2>/dev/null || echo 0 0)
    [ "${COLS:-0}" -gt 40 ] && break; sleep 0.1
  done
  [ "${COLS:-0}" -gt 40 ] || { COLS=200; ROWS=50; }
  "$TMUX_BIN" -L ui -f "$CFG/ui.conf" new-session -d -s ui -x "${COLS:-200}" -y "${ROWS:-50}" \
    "while :; do TMUX= $TMUX_BIN new-session -A -s main; sleep 0.5; done"
  # Width comes from ui.conf's @sidebar_width -- the single knob -- with the
  # same default the scripts use when the option is missing.
  SIDEBAR_WIDTH=$("$TMUX_BIN" -L ui show-options -gv @sidebar_width)
  case "$SIDEBAR_WIDTH" in '' | *[!0-9]*) SIDEBAR_WIDTH=$DEFAULT_SIDEBAR_WIDTH ;; esac
  CONTENT_PANE=$("$TMUX_BIN" -L ui display-message -p -t ui '#{pane_id}')
  "$TMUX_BIN" -L ui split-window -t ui -hb -l "$SIDEBAR_WIDTH" -c "$HOME" \
    -P -F '#{pane_id}' "exec $CFG/sidebar.sh" >/dev/null
  # Record the two pane ids as we build the layout, then publish them as tmux
  # options. Nothing depends on them any more -- ui.conf's guards match on
  # geometry (the sidebar is the left pane of a two-pane window) -- but they are
  # what the scripts and humans read to see which pane is which, and they must
  # be right before anything looks at them. (An earlier version hardcoded
  # indices here: the
  # config assumed sidebar=0/content=1 while the live server had sidebar=1/
  # content=2, so clicks and the focus redirect silently did nothing and the
  # sidebar's `fzf --no-input` ate the keyboard.)
  "$CFG/sidebar-ids.sh" set
  "$TMUX_BIN" -L ui select-pane -t "$CONTENT_PANE"
fi

exec "$TMUX_BIN" -L ui attach -t ui
