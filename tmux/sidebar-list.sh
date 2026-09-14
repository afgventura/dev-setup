#!/usr/bin/env bash
# Emits the sidebar rows: "<target>\t<display>" per line (ANSI allowed).
#   target = "@<window_id>"      a tab in the main session
#          = "sess:<name>"       another tmux session (orchestrator workers…)
#          = ""                  a group header (not clickable)
# Tabs are grouped by project folder — the first path component under
# ~/Workspace, "~" for the home dir, else the folder's basename — and other
# sessions on the server are listed under "workers" so they can be peeked at.
# Shared by sidebar.sh (initial list + reload), sidebar-click.sh (row → target)
# and sidebar-pos.sh (cursor row), so all three always agree.
# Runs on macOS' stock bash 3.2.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export LC_ALL=en_US.UTF-8   # printf pads by characters, not bytes
unset TMUX
W=${SIDEBAR_WIDTH:-51}
PAD=$((W - 5))          # "  " indent + marker + " " + name, one col spare
DIM=$'\e[2m'; RST=$'\e[0m'

# what the nested client is currently looking at
cur=$(tmux list-clients -F '#{client_session}' 2>/dev/null | head -1); cur=${cur:-main}

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
  m=" "; if [[ $cur == main && $active == 1 ]]; then m="▶"; elif [[ $act == 1 ]]; then m="•"; fi
  printf '%s\t%04d\t%s\t  %s %s\n' "$(group_of "$path")" "$idx" "$id" "$m" "$(pad "$name" "$PAD")"
done < <(tmux list-windows -t main -F $'#{window_id}\t#{window_index}\t#{window_active}\t#{window_activity_flag}\t#{pane_current_path}\t#{window_name}' 2>/dev/null) |
sort -t$'\t' -s -k1,1 -k2,2 |
while IFS=$'\t' read -r g idx target display; do
  [[ $g == "$prev" ]] || { printf '\t%s%s%s\n' "$DIM" "$g" "$RST"; prev=$g; }
  printf '%s\t%s\n' "$target" "$display"
done

# other sessions on this server = workers / side sessions, most recent first
others=$(tmux list-sessions -F $'#{session_name}\t#{session_activity}' 2>/dev/null | awk -F'\t' '$1!="main"' | sort -t$'\t' -k2 -rn | cut -f1)
if [[ -n $others ]]; then
  printf '\t%sworkers%s\n' "$DIM" "$RST"
  while IFS= read -r s; do
    m=" "; [[ $s == "$cur" ]] && m="▶"
    printf 'sess:%s\t  %s %s\n' "$s" "$m" "$(pad "$s" "$PAD")"
  done <<<"$others"
fi
