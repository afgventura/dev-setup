#!/usr/bin/env bash
# Acceptance test for the Ghostty + tmux sidebar setup. Quits/relaunches
# Ghostty, drives the exact byte sequences the ⌘ shortcuts send, simulates
# sidebar clicks, and checks the result. Run: ~/.config/tmux/selftest.sh
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset TMUX
T=tmux; F=0
pass(){ echo "PASS  $1"; }; fail(){ echo "FAIL  $1"; F=$((F+1)); }
w(){ $T list-windows -t main 2>/dev/null | wc -l | tr -d ' '; }

$T -L cfgtest -f ~/.config/tmux/ui.conf new-session -d -s ui 2>/tmp/ui.err; [ -s /tmp/ui.err ] && fail "ui.conf: $(cat /tmp/ui.err)" || pass "ui.conf loads"; $T -L cfgtest kill-server 2>/dev/null
$T -L cfgtest -f ~/.tmux.conf new-session -d -s main 2>/tmp/main.err; [ -s /tmp/main.err ] && fail "tmux.conf: $(cat /tmp/main.err)" || pass "tmux.conf loads"; $T -L cfgtest kill-server 2>/dev/null

osascript -e 'quit app "Ghostty"' 2>/dev/null; sleep 2; $T -L ui kill-server 2>/dev/null
$T has-session -t main 2>/dev/null || $T new-session -d -s main -c "$HOME"
# trim main to 2 empty tabs for a known state (only kills tabs running a bare shell)
for w in $($T list-windows -t main -F '#I #{pane_current_command}' | awk '$2 ~ /^(zsh|bash|sh)$/ {print $1}' | tail -n +3 | sort -rn); do $T kill-window -t "main:$w"; done
[ "$(w)" -ge 2 ] || $T new-window -t main -c "$HOME"
open -a Ghostty; sleep 3

L=$($T -L ui list-panes -t ui -F '#{pane_index}:#{pane_width}:#{pane_active}' | tr '\n' ' '); [[ "$L" == "0:51:0 1:"*":1 " ]] && pass "layout ($L)" || fail "layout ($L)"
SB=$($T -L ui capture-pane -p -t ui:.0); R0=$(sed -n 1p <<<"$SB"); [[ "$R0" == *TABS* ]] && pass "sidebar header" || fail "sidebar header [$R0]"
N0=$(w); $T -L ui send-keys -t ui:.1 C-b c; sleep 0.7; N1=$(w); [ "$N1" -eq $((N0+1)) ] && pass "⌘T creates tab ($N0→$N1)" || fail "⌘T ($N0→$N1)"
NEW=$($T display -t main -p '#I')   # the scratch tab; every mutating step below targets ONLY this tab
sleep 1; SB=$($T -L ui capture-pane -p -t ui:.0 | grep -v TABS | grep -cE "^(▶|•| ) "); [ "$SB" -eq "$N1" ] && pass "sidebar lists $SB tabs" || fail "sidebar lists $SB tabs, expected $N1"
$T -L ui send-keys -t ui:.1 C-b 1; sleep 0.5; A=$($T display -t main -p '#I'); [ "$A" = 1 ] && pass "⌘1 → tab 1" || fail "⌘1 → $A"
$T -L ui send-keys -t ui:.1 C-b 2; sleep 0.5; A=$($T display -t main -p '#I'); [ "$A" = 2 ] && pass "⌘2 → tab 2" || fail "⌘2 → $A"
sleep 0.5; ROW=$($T -L ui capture-pane -p -t ui:.0 | grep -n "▶" | cut -d: -f1); [ "$ROW" = 3 ] && pass "▶ tracks active tab" || fail "▶ on line $ROW, expected 3"
$T -L ui run-shell "~/.config/tmux/sidebar-click.sh $NEW"; sleep 0.6; A=$($T display -t main -p '#I'); [ "$A" = "$NEW" ] && pass "click row $NEW → tab $NEW" || fail "click row $NEW → $A"
FP=$($T -L ui display -p '#{pane_index}'); [ "$FP" = 1 ] && pass "focus stays on main pane" || fail "focus on pane $FP"
$T -L ui run-shell "~/.config/tmux/sidebar-click.sh 0"; sleep 0.3; A=$($T display -t main -p '#I'); [ "$A" = "$NEW" ] && pass "click header → no-op" || fail "click header → $A"
$T -L ui select-pane -t ui:.0; sleep 0.4; FP=$($T -L ui display -p '#{pane_index}'); [ "$FP" = 1 ] && pass "sidebar focus bounces back" || fail "focus stuck on pane $FP"
[ "$($T display -t main -p '#I')" = "$NEW" ] && [ "$($T display -t "main:$NEW" -p '#{pane_current_command}')" = zsh ] || { fail "scratch tab not active/bare — skipping input tests"; NEW=""; }
[ -n "$NEW" ] && { $T -L ui send-keys -t ui:.1 'echo typed-ok' Enter; sleep 2; $T capture-pane -p -t "main:$NEW" | grep -q typed-ok && pass "typing reaches main shell" || fail "typing lost"; }
$T -L ui capture-pane -p -t ui:.0 | grep -q typed && fail "text leaked into sidebar" || pass "sidebar untouched by typing"
[ -n "$NEW" ] && $T send-keys -t "main:$NEW" 'printf "\033]2;✳ Investigating memory\007"; sleep 4' Enter; sleep 1.5; $T -L ui capture-pane -p -t ui:.0 | grep -q "Investigating memory" && pass "tab name follows app title" || fail "title not synced: $($T list-windows -t main -F '#W' | tr '\n' ,)"
if [ -n "$NEW" ] && [ "$($T display -t main -p '#I')" = "$NEW" ]; then $T -L ui send-keys -t ui:.1 C-b x; else $T kill-window -t "main:$NEW" 2>/dev/null; fi; sleep 0.7; N2=$(w); [ "$N2" -eq $((N1-1)) ] && pass "⌘W closes tab ($N1→$N2)" || fail "⌘W ($N1→$N2)"
sleep 1; SB=$($T -L ui capture-pane -p -t ui:.0 | grep -v TABS | grep -cE "^(▶|•| ) "); [ "$SB" -eq "$N2" ] && pass "sidebar updates after close" || fail "sidebar shows $SB after close, expected $N2"
$T -L ui send-keys -t ui:.1 C-b s; sleep 0.5; M=$($T display -t main -p '#{pane_in_mode}'); $T -L ui send-keys -t ui:.1 Escape; sleep 0.3; [ "$M" = 1 ] && pass "⌘S opens picker" || fail "⌘S picker mode=$M"
osascript -e 'quit app "Ghostty"'; sleep 2; pgrep -x ghostty >/dev/null && fail "ghostty still running" || pass "ghostty exits"
$T -L ui ls >/dev/null 2>&1 && fail "ui server survived" || pass "ui chrome cleaned up"
pgrep -f "tmux/sidebar.sh" >/dev/null && fail "sidebar proc survived" || pass "sidebar proc gone"
$T ls >/dev/null 2>&1 && pass "main survives ($(w) tabs)" || fail "main died"
open -a Ghostty; sleep 3; $T -L ui capture-pane -p -t ui:.0 | grep -q "TABS" && pass "reopen shows sidebar" || fail "reopen no sidebar"
L=$($T -L ui list-panes -t ui -F '#{pane_width}' | head -1); [ "$L" = 51 ] && pass "sidebar width after reopen = 51" || fail "sidebar width after reopen = $L"
echo; echo "== $F failure(s) =="; echo; $T -L ui capture-pane -p -t ui:.0 | sed '/^\s*$/d'
