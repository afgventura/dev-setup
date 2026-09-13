#!/usr/bin/env bash
# Ghostty's `command`. Layout:
#   ┌────────┬──────────────────────────┐
#   │ TABS   │  tmux session "main"     │
#   │ (fzf)  │  (your real shell/agents)│
#   └────────┴──────────────────────────┘
# "main" survives Ghostty being closed; "ui" is throwaway chrome.
set -u
TMUX_BIN=/opt/homebrew/bin/tmux
CFG="$HOME/.config/tmux"
SIDEBAR_WIDTH=51

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
  "$TMUX_BIN" -L ui split-window -t ui -hb -l "$SIDEBAR_WIDTH" -c "$HOME" "exec $CFG/sidebar.sh"
  "$TMUX_BIN" -L ui select-pane -t ui:.1
fi

exec "$TMUX_BIN" -L ui attach -t ui
