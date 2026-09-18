#!/usr/bin/env bash
# dev-setup installer (macOS). Idempotent — safe to re-run after `git pull`.
#
#   ./install.sh            # everything
#   ./install.sh terminal   # ghostty + tmux + notifier only
#   ./install.sh pi         # pi coding agent config only
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
what="${1:-all}"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
link() {  # link SRC DST — symlink, backing up a real file if one is in the way
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then mv "$dst" "$dst.bak-$(date +%Y%m%d%H%M%S)"; fi
  ln -sfn "$src" "$dst"
}

if [ "$what" = all ] || [ "$what" = terminal ]; then
  say "dependencies (brew)"
  for f in ghostty; do brew list --cask "$f" >/dev/null 2>&1 || brew install --cask "$f"; done
  for f in tmux fzf jq; do brew list "$f" >/dev/null 2>&1 || brew install "$f"; done

  say "tmux"
  link "$REPO/tmux/tmux.conf" "$HOME/.tmux.conf"
  for f in ui.conf ghostty-ui.sh sidebar.sh sidebar-list.sh sidebar-refresh.sh sidebar-click.sh sidebar-pos.sh sidebar-nav.sh sidebar-redraw.sh open-url.sh copy-release.sh agent-notify.sh selftest.sh clicktest.py; do
    link "$REPO/tmux/$f" "$HOME/.config/tmux/$f"
  done

  say "ghostty"
  mkdir -p "$HOME/.config/ghostty"
  cat > "$HOME/.config/ghostty/config" <<EOF
# Managed by dev-setup — edit $REPO/ghostty/config instead.
config-file = $REPO/ghostty/config
command = $HOME/.config/tmux/ghostty-ui.sh
EOF

  say "Agent Notifier.app"
  "$REPO/agent-notifier/build.sh"

  say "Claude Code hooks (Stop / Notification → notifier; Bash → search guard)"
  link "$REPO/claude/guard-search.sh" "$HOME/.config/claude/guard-search.sh"
  S="$HOME/.claude/settings.json"; mkdir -p "$HOME/.claude"; [ -f "$S" ] || echo '{}' > "$S"
  jq --slurpfile h "$REPO/claude/hooks.json" '
    .hooks //= {} |
    reduce ($h[0] | to_entries[]) as $e (.;
      .hooks[$e.key] = (((.hooks[$e.key] // []) | map(select(.hooks[0].command != $e.value[0].hooks[0].command))) + $e.value))
  ' "$S" > "$S.tmp" && mv "$S.tmp" "$S"

  say "ssh: reuse the GitHub connection (every fetch/push otherwise pays a ~2 s handshake)"
  C="$HOME/.ssh/config"; mkdir -p "$HOME/.ssh"; touch "$C"; chmod 600 "$C"
  grep -q "dev-setup: reuse one SSH connection" "$C" || { printf '\n' >> "$C"; cat "$REPO/ssh/config.snippet" >> "$C"; }

  say "Codex config + hooks (search guard; Codex asks once to trust it)"
  C="$HOME/.codex/config.toml"; mkdir -p "$HOME/.codex"; touch "$C"
  if [ -f "$HOME/.codex/hooks.json" ] && ! grep -q guard-search "$HOME/.codex/hooks.json"; then
    jq -s '.[0] * .[1]' "$HOME/.codex/hooks.json" "$REPO/codex/hooks.json" > "$HOME/.codex/hooks.json.tmp" && mv "$HOME/.codex/hooks.json.tmp" "$HOME/.codex/hooks.json"
  elif [ ! -f "$HOME/.codex/hooks.json" ]; then cp "$REPO/codex/hooks.json" "$HOME/.codex/hooks.json"; fi
  if ! grep -q "agent-notify.sh" "$C"; then
    printf '\n' >> "$C"; sed "s|~/.config|$HOME/.config|" "$REPO/codex/config.snippet.toml" >> "$C"
  fi

  say "reload (live sessions)"
  tmux source-file "$HOME/.tmux.conf" 2>/dev/null || true
  tmux -L ui source-file "$HOME/.config/tmux/ui.conf" 2>/dev/null || true
  echo "   Ghostty: press ⌘⇧, (Reload Configuration) or relaunch."
fi

if [ "$what" = all ] || [ "$what" = pi ]; then
  say "pi coding agent"
  command -v pi >/dev/null 2>&1 || npm install -g @earendil-works/pi-coding-agent
  mkdir -p "$HOME/.pi/agent/extensions"
  # settings/mcp are copied (pi rewrites them); extension is linked
  for f in settings.json mcp.json models.json; do
    if [ -f "$HOME/.pi/agent/$f" ]; then
      jq -s '.[0] * .[1]' "$HOME/.pi/agent/$f" "$REPO/pi/$f" > "$HOME/.pi/agent/$f.tmp" && mv "$HOME/.pi/agent/$f.tmp" "$HOME/.pi/agent/$f"
    else cp "$REPO/pi/$f" "$HOME/.pi/agent/$f"; fi
  done
  link "$REPO/pi/extensions/loop.ts" "$HOME/.pi/agent/extensions/loop.ts"
  link "$REPO/pi/extensions/tasks.ts" "$HOME/.pi/agent/extensions/tasks.ts"
  link "$REPO/pi/extensions/skills-inline.ts" "$HOME/.pi/agent/extensions/skills-inline.ts"
  link "$REPO/pi/extensions/no-mesh.ts" "$HOME/.pi/agent/extensions/no-mesh.ts"
  link "$REPO/pi/extensions/guard-search.ts" "$HOME/.pi/agent/extensions/guard-search.ts"
  link "$REPO/pi/extensions/wheel.ts" "$HOME/.pi/agent/extensions/wheel.ts"
  link "$REPO/pi/extensions/tab-status.ts" "$HOME/.pi/agent/extensions/tab-status.ts"
  link "$REPO/pi/extensions/tmux-window-name" "$HOME/.pi/agent/extensions/tmux-window-name"
  # one catch-all subagent type, model pinned; pi-subagents' built-ins are off
  mkdir -p "$HOME/.pi/agent/agents"
  link "$REPO/pi/agents/general-purpose.md" "$HOME/.pi/agent/agents/general-purpose.md"
  S="$HOME/.pi/agent/subagents.json"
  if [ -f "$S" ]; then jq -s '.[0] * .[1]' "$S" "$REPO/pi/subagents.json" > "$S.tmp" && mv "$S.tmp" "$S"; else cp "$REPO/pi/subagents.json" "$S"; fi
  echo "   pi packages install on first run from settings.json → packages"
fi

say "done"
