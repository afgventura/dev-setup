#!/usr/bin/env bash
# PreToolUse hook (Claude Code and Codex share the JSON-on-stdin, exit-2-blocks
# protocol) for the shell tool: refuse the slow searches.
# `grep -r` and a directory-walking `find` read every file under the path,
# node_modules and all (25k tracked files, millions untracked across the
# worktrees); rg/fd honour .gitignore and take well under a second. Exit 2 =
# block the call and hand the message back to the model.
bare=$(python3 -c '
import json, re, sys
c = json.load(sys.stdin).get("tool_input", {}).get("command", "")
# Codex passes the argv list (["bash","-lc","..."]); Claude Code the string
c = " ".join(c) if isinstance(c, list) else c
# Only the code is inspected: heredoc bodies and quoted strings are dropped,
# so a literal "find" in a commit message or in a file being written is fine.
c = re.sub(r"<<-?\s*[\x27\"]?(\w+)[\x27\"]?[^\n]*\n.*?\n\1(?=\n|$)", "", c, flags=re.S)
c = re.sub(r"\x27[^\x27]*\x27|\"[^\"]*\"", "", c)
print(c)' 2>/dev/null) || exit 0
[ -n "$bare" ] || exit 0
if printf '%s' "$bare" | grep -Eq '(^|[;&|(]|\s)grep(\s+[^|;&[:space:]]+)*\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--(dereference-)?recursive)(\s|$)'; then
  echo "blocked: recursive grep walks node_modules and every worktree. Use rg (respects .gitignore): rg -n 'pattern' path  — or the Grep tool." >&2
  exit 2
fi
if printf '%s' "$bare" | grep -Eq '(^|[;&|(]|\s)find\s+[^|;&]*' && ! printf '%s' "$bare" | grep -Eq '(^|[;&|(]|\s)find\s+[^|;&]*-maxdepth\s+[012](\s|$)'; then
  echo "blocked: find walks node_modules and every worktree. Use fd (respects .gitignore): fd 'name' path  — or the Glob tool. (find with -maxdepth 0-2 is allowed.)" >&2
  exit 2
fi
# Local Vite dev servers are disabled on this machine: apps/web/vite.config.ts
# refuses `vite dev` without HALOAI_ALLOW_VITE_DEV=1, and agents that read the
# error simply set the variable. Refuse the variable and the serve forms here;
# ~/.config/tmux/vite-watchdog.sh kills anything that still slips through. The
# two legitimate callers (route generation, wifi-e2e) set the variable inside
# their own scripts, so invoking those scripts by name still works.
if printf '%s' "$bare" | grep -Eq 'HALOAI_ALLOW_VITE_DEV|(^|[;&|(]|\s)(npx\s+|pnpm\s+(exec\s+)?|bunx\s+|bun\s+x\s+)?vite(\s+(dev|serve|--host|--port|--open)|\s*$|\s*[;&|])|(^|[;&|(]|\s)pnpm(\s+(-F|--filter)\s+\S+)?\s+(run\s+)?dev(\s|$)' \
   && ! printf '%s' "$bare" | grep -Eq 'scripts/generate-routes\.sh|wifi-e2e/scripts/dev-server\.sh'; then
  echo "blocked: local dev servers are disabled on this machine (device-hygiene). Validate on https://staging.haloai.co.id or production via Chrome MCP; for a build use \`vite build\`. HALOAI_ALLOW_VITE_DEV is reserved for scripts/generate-routes.sh and apps/wifi-e2e/scripts/dev-server.sh — a server started any other way is killed by the watchdog." >&2
  exit 2
fi
exit 0
