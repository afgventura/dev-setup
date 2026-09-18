#!/usr/bin/env bash
# Kill any local Vite dev server an agent starts, however it was started.
#
# apps/web/vite.config.ts refuses `vite dev` unless HALOAI_ALLOW_VITE_DEV=1,
# and the PreToolUse guard (claude/guard-search.sh, pi/extensions/guard-search.ts)
# refuses commands that set it — but a hook only sees the command text, so a
# server started from a script file, a subagent, or a pnpm script alias gets
# through. This runs from launchd every few seconds and kills the process
# itself. Allowed: a vite whose ancestry includes one of the two scripts that
# legitimately need a dev server (route generation, wifi-e2e). `vite build`
# and `vite preview` are not dev servers and are left alone.
#
# Log: ~/.local/state/vite-watchdog.log

LOG="$HOME/.local/state/vite-watchdog.log"
mkdir -p "$(dirname "$LOG")"

allowed_ancestor() {  # $1 = pid; true if any ancestor is a permitted caller
  local pid=$1 args
  while [ "$pid" -gt 1 ] 2>/dev/null; do
    args=$(ps -o args= -p "$pid" 2>/dev/null) || return 1
    case "$args" in
      *scripts/generate-routes.sh*|*wifi-e2e/scripts/dev-server.sh*) return 0 ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$pid" ] || return 1
  done
  return 1
}

# vite's CLI: `vite` / `vite dev` / `vite serve` start the dev server; anything
# else (build, preview, optimize) is a one-shot or not a dev server.
# Match on the executable (comm), not the command line: a shell whose -c text
# merely mentions vite.js (an agent wrapper, an rg over the config) is not vite.
ps -eo pid=,comm=,args= | while read -r pid comm args; do
  case "${comm##*/}" in node|bun) ;; *) continue ;; esac
  case "$args" in
    *vite/bin/vite.js*|*.bin/vite\ *|*.bin/vite) ;;
    *) continue ;;
  esac
  rest=${args#*vite.js}
  [ "$rest" = "$args" ] && rest=${args#*.bin/vite}
  case "$rest" in *vite*) rest=${rest%%vite.js*} ;; esac
  set -- $rest
  sub=${1:-}
  case "$sub" in
    build|preview|optimize) continue ;;
  esac
  allowed_ancestor "$pid" && continue
  cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  if [ -n "${DRY:-}" ]; then echo "would kill pid=$pid args=$rest"; continue; fi
  kill -TERM "$pid" 2>/dev/null
  printf '%s killed vite dev pid=%s cwd=%s args=%s\n' "$(date '+%F %T')" "$pid" "${cwd:-?}" "$rest" >> "$LOG"
  # the parent `pnpm exec vite` / `pnpm dev` chain would otherwise report a
  # crash and some agents retry; killing it makes the outcome unambiguous
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  while [ -n "$ppid" ] && [ "$ppid" -gt 1 ]; do
    pargs=$(ps -o args= -p "$ppid" 2>/dev/null) || break
    case "$pargs" in
      *pnpm*exec*vite*|*pnpm*dev*|*npx*vite*|*bunx*vite*) kill -TERM "$ppid" 2>/dev/null; ppid=$(ps -o ppid= -p "$ppid" 2>/dev/null | tr -d ' ') ;;
      *) break ;;
    esac
  done
done
exit 0
