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
W=${SIDEBAR_WIDTH:-51}
PAD=$((W - 5))          # "  " indent + marker + " " + name, one col spare
DIM=$'\e[2m'; RST=$'\e[0m'


pad() {  # pad/truncate $1 to $2 display characters (bash 3.2 printf pads bytes)
  local s=${1:0:$2}; printf '%s%*s' "$s" $(( $2 - ${#s} )) ''
}

group_of() {  # path → group name
  local p=$1 ws="$HOME/Workspace/"
  if [[ $p == "$ws"* ]]; then p=${p#"$ws"}; echo "${p%%/*}"
  elif [[ $p == "$HOME" ]]; then echo "~"
  else basename "$p"; fi
}

# group \t window-index \t target \t display  → stable sort by group keeps tab order
prev=""
while IFS=$'\t' read -r id idx active act path name; do
  m=" "; if [[ $active == 1 ]]; then m="▶"; elif [[ $act == 1 ]]; then m="•"; fi
  printf '%s\t%04d\t%s\t  %s %s\n' "$(group_of "$path")" "$idx" "$id" "$m" "$(pad "$name" "$PAD")"
done < <(tmux list-windows -t main -F $'#{window_id}\t#{window_index}\t#{window_active}\t#{window_activity_flag}\t#{pane_current_path}\t#{window_name}' 2>/dev/null) |
sort -t$'\t' -s -k1,1 -k2,2 |
while IFS=$'\t' read -r g idx target display; do
  [[ $g == "$prev" ]] || { printf '\t%s%s%s\n' "$DIM" "$g" "$RST"; prev=$g; }
  printf '%s\t%s\n' "$target" "$display"
done

