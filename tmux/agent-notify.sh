#!/usr/bin/env bash
# macOS notification (posted BY GHOSTTY, via the OSC 777 escape sequence)
# when an AI agent finishes a turn or needs input.
#   Claude Code hook (Stop / Notification): JSON on stdin
#   Codex notify:  agent-notify.sh codex '<json>'
# The sequence is written directly to the tty of Ghostty's tmux client, so it
# bypasses both tmux layers (which would otherwise swallow it). Skipped when
# Ghostty is frontmost AND the agent's tab is the active one.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
TMUX_BIN=/opt/homebrew/bin/tmux

if [ "${1:-}" = codex ]; then
  agent="Codex"; json=${2:-}
  msg=$(printf '%s' "$json" | jq -r '.["last-assistant-message"] // "Turn complete"' 2>/dev/null)
else
  agent="Claude Code"; json=$(cat)
  event=$(printf '%s' "$json" | jq -r '.hook_event_name // ""' 2>/dev/null)
  if [ "$event" = Notification ]; then
    msg=$(printf '%s' "$json" | jq -r '.message // "Needs your attention"' 2>/dev/null)
  else
    msg=$(printf '%s' "$json" | jq -r '.last_assistant_message // "Done — waiting for you"' 2>/dev/null)
  fi
fi
# one line, bounded, and no ';' / control chars (OSC field separators)
msg=$(printf '%s' "$msg" | tr '\n\r;' '  ,' | tr -d '\000-\037' | cut -c1-160)

tab=""; win=""; active=0
if [ -n "${TMUX_PANE:-}" ]; then
  read -r win tab active < <(TMUX= "$TMUX_BIN" display -t "$TMUX_PANE" -p '#{window_id} #{window_name} #{window_active}' 2>/dev/null)
fi
tab=$(printf '%s' "${tab:-$(basename "$PWD")}" | tr -d ';')

front=$(osascript -e 'tell application "System Events" to get bundle identifier of first process whose frontmost is true' 2>/dev/null)
[ "$front" = com.mitchellh.ghostty ] && [ "$active" = 1 ] && exit 0

# Preferred: our own "Agent Notifier" app — native banner; clicking it jumps
# to the agent's tab and brings Ghostty forward.
APP="$HOME/Applications/Agent Notifier.app"
if [ -x "$APP/Contents/MacOS/agent-notifier" ]; then
  click="open -b com.mitchellh.ghostty"
  [ -n "$win" ] && click="TMUX= $TMUX_BIN select-window -t 'main:$win'; $click"
  q="$HOME/.local/state/agent-notifier/queue"; mkdir -p "$q"
  jq -n --arg id "agent-${win:-$$}" --arg t "$agent" --arg s "$tab" --arg b "$msg" --arg x "$click" \
     '{id:$id,title:$t,subtitle:$s,body:$b,exec:$x}' > "$q/$$.tmp" && mv "$q/$$.tmp" "$q/$(date +%s)-$$.json"
  if ! pgrep -f "Agent Notifier.app/Contents/MacOS/agent-notifier" >/dev/null; then
    open -g -a "$APP" 2>/dev/null || { nohup "$APP/Contents/MacOS/agent-notifier" >/dev/null 2>&1 & disown; }
  fi
  exit 0
fi

# Fallback: Ghostty's own notification via OSC 777 (focuses Ghostty only)
tty=$(TMUX= "$TMUX_BIN" -L ui list-clients -F '#{client_tty}' 2>/dev/null | head -1)
if [ -n "$tty" ] && [ -w "$tty" ]; then
  printf '\033]777;notify;%s — %s;%s\007' "$agent" "$tab" "$msg" > "$tty"
else
  osascript -e "display notification \"$msg\" with title \"$agent\" subtitle \"$tab\"" >/dev/null 2>&1
fi
