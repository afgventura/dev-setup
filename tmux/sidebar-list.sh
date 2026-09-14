#!/usr/bin/env bash
# Emits the sidebar rows: "<target>\t<display>" per line (ANSI allowed).
#   target = "@<window_id>"      a tab in the main session
#          = ""                  a group header (not clickable)
# Tabs are grouped by project folder — the first path component under
# ~/Workspace, "~" for the home dir, else the folder's basename. Only the
# main session is listed; other sessions (orchestrator workers) are
# deliberately hidden.
# Shared by sidebar.sh (initial list + reload), sidebar-click.sh (row → target)
# and sidebar-pos.sh (cursor row), so all three always agree.
# Runs on macOS' stock bash 3.2.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export LC_ALL=en_US.UTF-8   # printf pads by characters, not bytes
unset TMUX
exec 2>/dev/null   # never let a stray error reach tmux/fzf output
W=${SIDEBAR_WIDTH:-51}
PAD=$((W - 9))          # fzf left margin 4 + "  " indent + marker + " " + name, one col spare
DIM=$'\e[2m'; RST=$'\e[0m'

# This runs up to ten times a second while agents animate their titles, so no
# subprocesses per row: pure bash string ops only, one tmux call, one sort.

group_of() {  # path → group name, in $REPLY
  local p=$1 ws="$HOME/Workspace/"
  if [[ $p == "$ws"* ]]; then p=${p#"$ws"}; REPLY=${p%%/*}
  elif [[ $p == "$HOME" ]]; then REPLY="~"
  else REPLY=${p##*/}; fi
}

is_braille() {  # Claude Code's title spinner: U+2800–U+28FF = bytes E2 A0..A3 xx
  local LC_ALL=C
  [[ $1 == $'\xe2'[$'\xa0'-$'\xa3']* ]]
}

# group \t window-index \t target \t display  → stable sort by group keeps tab order
prev=""
while IFS=$'\t' read -r id idx active act path name; do
  m=" "; if [[ $active == 1 ]]; then m="▶"; elif [[ $act == 1 ]]; then m="•"; fi
  # show one steady glyph instead of the spinner so the sidebar isn't redrawn per frame
  if is_braille "$name"; then name="⋯${name:1}"; fi
  group_of "$path"
  name=${name:0:$PAD}
  printf '%s\t%04d\t%s\t  %s %s%*s\n' "$REPLY" "$idx" "$id" "$m" "$name" $(( PAD - ${#name} )) ''
done < <(tmux list-windows -t main -F $'#{window_id}\t#{window_index}\t#{window_active}\t#{window_activity_flag}\t#{pane_current_path}\t#{window_name}' 2>/dev/null) |
sort -t$'\t' -s -k1,1 -k2,2 |
while IFS=$'\t' read -r g idx target display; do
  [[ $g == "$prev" ]] || { printf '\t%s%s%s\n' "$DIM" "$g" "$RST"; prev=$g; }
  printf '%s\t%s\n' "$target" "$display"
done
