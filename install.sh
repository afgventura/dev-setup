#!/usr/bin/env bash
# dev-setup installer (macOS; the pi section also runs on Linux). Idempotent —
# safe to re-run after `git pull`.
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
  for f in ui.conf ghostty-ui.sh sidebar.sh sidebar-list.sh sidebar-refresh.sh sidebar-click.sh sidebar-pos.sh sidebar-nav.sh sidebar-redraw.sh sidebar-ids.sh open-url.sh copy-release.sh agent-notify.sh vite-watchdog.sh selftest.sh clicktest.py; do
    link "$REPO/tmux/$f" "$HOME/.config/tmux/$f"
  done

  say "vite watchdog (launchd, every 5 s: kills agent-started Vite dev servers)"
  mkdir -p "$HOME/Library/LaunchAgents"
  P="$HOME/Library/LaunchAgents/com.gery.vite-watchdog.plist"
  sed "s|HOME_PLACEHOLDER|$HOME|" "$REPO/launchd/com.gery.vite-watchdog.plist" > "$P"
  launchctl bootout "gui/$(id -u)/com.gery.vite-watchdog" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$P"

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
      .hooks[$e.key] = (((.hooks[$e.key] // []) | map(select(.hooks[0].command as $c | $e.value[0].hooks[0].command as $n | ($c != $n) and ((($c | tostring | test("agent-notify[.]sh")) and ($n | test("agent-notify[.]sh"))) | not)))) + $e.value))
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
  # A reload re-applies the bindings/hooks but not the layout, so leave the live
  # chrome server consistent: sidebar-redraw.sh re-records @sidebar/@content and
  # puts the sidebar back to @sidebar_width (it also repaints). Sourcing ui.conf
  # used to be enough to strand the keyboard on the sidebar, because the file
  # itself blanked the ids the click guards compared against.
  "$HOME/.config/tmux/sidebar-redraw.sh" >/dev/null 2>&1 || true
  echo "   Ghostty: press ⌘⇧, (Reload Configuration) or relaunch."
fi

if [ "$what" = all ] || [ "$what" = pi ]; then
  say "pi coding agent"
  # Honour pi's own override so this works on machines that do not use ~/.pi/agent.
  PI_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  command -v pi >/dev/null 2>&1 || npm install -g @earendil-works/pi-coding-agent
  mkdir -p "$PI_AGENT/extensions"
  # config files are copied (pi rewrites them); extensions are linked
  for f in settings.json mcp.json mcp-adapter.json models.json subagents-local.json tasks-config.json; do
    if [ -f "$PI_AGENT/$f" ]; then
      jq -s '.[0] * .[1]' "$PI_AGENT/$f" "$REPO/pi/$f" > "$PI_AGENT/$f.tmp" && mv "$PI_AGENT/$f.tmp" "$PI_AGENT/$f"
    else cp "$REPO/pi/$f" "$PI_AGENT/$f"; fi
  done
  # Subagent children are full sessions now; drop the old slim-child tool allowlist,
  # which hid every extension and MCP tool (the merge above cannot remove a key).
  jq 'del(.tools)' "$PI_AGENT/subagents-local.json" > "$PI_AGENT/subagents-local.json.tmp" \
    && mv "$PI_AGENT/subagents-local.json.tmp" "$PI_AGENT/subagents-local.json"
  link "$REPO/pi/extensions/loop.ts" "$PI_AGENT/extensions/loop.ts"
  link "$REPO/pi/extensions/tasks.ts" "$PI_AGENT/extensions/tasks.ts"
  link "$REPO/pi/extensions/goal.ts" "$PI_AGENT/extensions/goal.ts"
  link "$REPO/pi/extensions/skills-inline.ts" "$PI_AGENT/extensions/skills-inline.ts"
  link "$REPO/pi/extensions/no-mesh.ts" "$PI_AGENT/extensions/no-mesh.ts"
  link "$REPO/pi/extensions/guard-search.ts" "$PI_AGENT/extensions/guard-search.ts"
  link "$REPO/pi/extensions/tab-status.ts" "$PI_AGENT/extensions/tab-status.ts"
  link "$REPO/pi/extensions/pi-subagents-local.ts" "$PI_AGENT/extensions/pi-subagents-local.ts"
  link "$REPO/pi/extensions/pi-subagents-ui.ts" "$PI_AGENT/extensions/pi-subagents-ui.ts"
  link "$REPO/pi/extensions/tmux-window-name" "$PI_AGENT/extensions/tmux-window-name"
  link "$REPO/pi/extensions/byteplus-pricing.ts" "$PI_AGENT/extensions/byteplus-pricing.ts"
  # one catch-all subagent type, model pinned; the old in-process engines are off.
  # Subagents run as child pi processes (with extensions, MCP and skills) via
  # extensions/pi-subagents-local.ts,
  # which speaks the same subagents:rpc v2 protocol that cc-my-pi's tasks expect.
  mkdir -p "$PI_AGENT/agents"
  link "$REPO/pi/agents/general-purpose.md" "$PI_AGENT/agents/general-purpose.md"
  S="$PI_AGENT/subagents.json"
  if [ -f "$S" ]; then jq -s '.[0] * .[1]' "$S" "$REPO/pi/subagents.json" > "$S.tmp" && mv "$S.tmp" "$S"; else cp "$REPO/pi/subagents.json" "$S"; fi
  # The globally installed pi has no `quietExtensionWarnings` setting (the fork does), so startup
  # warns about extension manifests pi cannot fix. Patch the installed dist; re-run after a pi update.
  link "$REPO/pi/patches/quiet-extension-warnings.mjs" "$PI_AGENT/patches/quiet-extension-warnings.mjs"
  node "$PI_AGENT/patches/quiet-extension-warnings.mjs" ||
    echo "   quiet-extension-warnings: not applied (this pi is not a version the patch knows) — re-port it"
  # cc-my-pi declares maxVisible/showAll but its task widget renders every task, so a
  # long list takes the screen; this makes the declared setting real. Re-run after
  # `pi update --extensions`, which reinstalls the package.
  node "$REPO/pi/patches/cap-task-widget.mjs"
  # cc-my-pi's statusline renders a fixed five extension statuses and silently drops every
  # other one, so the state this repo's own extensions publish (a watch or background run,
  # the loop, the goal, the subagent count) never reached the footer. Re-run after
  # `pi update --extensions`, which reinstalls the package.
  node "$REPO/pi/patches/statusline-armed-statuses.mjs"
  # cc-my-pi's git-info runs `git status --untracked-files=all` after every tool call in
  # every pi process. Many sessions in one checkout then hold .git/index.lock nearly all
  # the time and every pull or reset fails. Re-run after `pi update --extensions`.
  node "$REPO/pi/patches/cc-my-pi-no-git-poll.mjs"
  echo "   pi packages install on first run from settings.json → packages"

  say "pi package auto-update (launchd: at login and every 12 h)"
  # Keeps the extension packages current so the "Package Updates Available" banner
  # stops appearing. `pi update --extensions` only -- a plain `pi update` would
  # self-update pi and drop the patch applied just above.
  link "$REPO/pi/pi-package-update.sh" "$HOME/.config/pi/pi-package-update.sh"
  if [ "$(uname)" = "Darwin" ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    P="$HOME/Library/LaunchAgents/com.gery.pi-package-update.plist"
    sed "s|HOME_PLACEHOLDER|$HOME|" "$REPO/launchd/com.gery.pi-package-update.plist" > "$P"
    launchctl bootout "gui/$(id -u)/com.gery.pi-package-update" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$P"
    echo "   log: ~/.local/state/pi-package-update.log (only when something changed or failed)"
  else
    echo "   launchd is macOS-only; on Linux run ~/.config/pi/pi-package-update.sh from cron if wanted"
  fi
fi

say "done"
