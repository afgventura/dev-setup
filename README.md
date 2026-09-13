# dev-setup

A lightweight terminal workspace for running many AI coding agents
(Claude Code, Codex, pi) side by side on a Mac without eating all the RAM.

```
┌──────────────────┬────────────────────────────────────────┐
│ TABS             │                                        │
│   ~              │   tmux session "main"                  │
│ • ✳ Fix CI       │   (your shells / agents, persistent)   │
│ ▶ ✳ Add sidebar  │                                        │
└──────────────────┴────────────────────────────────────────┘
   Ghostty window — the only terminal process; ⌘Q it any time
```

**What you get**

- **Ghostty** as the window (native, ~100 MB for everything) with **tmux** owning
  the sessions — close Ghostty, reopen it, every agent is still running.
- A **left sidebar** listing tabs, clickable; names follow the agent's own
  terminal title (Claude Code sets one per task, so tabs relabel themselves).
  `▶` = active, `•` = new output since you last looked.
- **⌘ shortcuts** that feel like a normal Mac app — no tmux prefix to learn.
- **Native macOS notifications** when an agent finishes or needs input;
  clicking one jumps to that tab.
- Shift+Enter inserts a newline in Claude Code / Codex (through both tmux layers).
- Truecolor + extended keys wired through, so agents render as they do natively.

## Install

```sh
git clone git@github.com:afgventura/dev-setup.git ~/Workspace/dev-setup
~/Workspace/dev-setup/install.sh          # or: install.sh terminal | install.sh pi
```

Then open Ghostty. First notification will ask to allow **Agent Notifier** — click Allow.

`install.sh` is idempotent: it symlinks the tmux files, generates
`~/.config/ghostty/config` (pointing at this repo), builds the notifier app,
merges the Claude Code hooks into `~/.claude/settings.json`, appends the
Codex snippet, and copies the pi config. Re-run after `git pull`.

## Shortcuts

| Key | Action |
|---|---|
| ⌘T / ⌘W | new tab / close tab |
| ⌘1–9 | jump to tab |
| ⌘⇧[ / ⌘⇧] | previous / next tab |
| ⌘S | full-screen tab picker (Esc closes) |
| ⌘R | rename tab (sticks until closed) |
| ⌘D / ⌘⇧D | split right / down |
| ⌘⌥ arrows | move between splits |
| ⌘⇧K | clear scrollback |
| Shift+Enter | newline in an agent prompt |
| mouse | click a sidebar row to switch; scroll; drag split borders |

## How it works

Two tmux servers. `main` (default socket) holds your real tabs. `ui`
(`-L ui`, config `tmux/ui.conf`) is throwaway chrome: a 51-column pane running
`sidebar.sh` (fzf as a pure display) next to a pane that just attaches `main`.
It has no prefix, so every `C-b …` sequence Ghostty's ⌘ keybinds emit passes
straight through to `main`. When the last Ghostty client detaches, `ui` kills
itself; `main` lives on.

Sidebar updates are event-driven: hooks in `tmux.conf` call
`sidebar-refresh.sh`, which POSTs a `reload-sync` to fzf over a unix socket.
Clicks are handled by tmux (`MouseDown1Pane` → `sidebar-click.sh`), never by
fzf, so keyboard focus can't land in the sidebar.

`agent-notify.sh` is the Claude Code `Stop`/`Notification` hook and Codex's
`notify` hook. It drops a JSON request into `~/.local/state/agent-notifier/queue`;
`Agent Notifier.app` (tiny Swift app, `agent-notifier/`) posts the banner and,
on click, runs `tmux select-window` + brings Ghostty forward. Suppressed when
Ghostty is frontmost and that tab is already active.

## Layout

```
ghostty/config            font, theme, ⌘ keybinds (→ tmux prefix sequences)
tmux/tmux.conf            main server: bindings, title→tab-name rule, hooks
tmux/ui.conf              outer chrome: sidebar pane, mouse, focus rules
tmux/ghostty-ui.sh        Ghostty's `command`: builds the layout, attaches
tmux/sidebar*.sh          the sidebar and its refresh/click/position helpers
tmux/agent-notify.sh      notification hook (Claude Code + Codex)
tmux/selftest.sh          acceptance test (quits/relaunches Ghostty, ~25 s)
tmux/clicktest.py         injects real mouse bytes to test sidebar clicks
agent-notifier/           Swift source + build script for the notifier app
claude/hooks.json         hook entries merged into ~/.claude/settings.json
codex/config.snippet.toml notify hook + shared Chrome MCP over HTTP
pi/                       pi coding agent: settings, models (context window), MCP servers, /loop extension
```

## Tuning

- Sidebar width: `SIDEBAR_WIDTH` in `tmux/ghostty-ui.sh`, the `-x` in
  `tmux/ui.conf`, and the `p48/=48` pad in `sidebar.sh` + `sidebar-refresh.sh`
  (pad = width − 3).
- Active-row colour: `bg+:#0969da` in `sidebar.sh`.
- MCP tokens for pi are read from env vars named in `pi/mcp.json`
  (`bearerTokenEnv`) — keep secrets in the Keychain and export them from your
  shell rc, e.g. `export X="$(security find-generic-password -a "$USER" -s "haloai-shell:X" -w)"`.

## pi

`pi/settings.json` lists the packages pi installs on first run
(`cc-my-pi`, `pi-mcp-adapter`, `pi-tmux-window-name`, ralph loop, …).
`pi/extensions/loop.ts` adds `/loop <interval> <prompt>` like Claude Code's.
`pi/models.json` caps deepseek-v4.1-flash at a 500k window (of its nominal 1M) so
auto-compaction and the ctx meter both work off 500k — cost isn't the constraint
at $0.003/M cached input; long-context quality and latency are.
Skills are provided by those packages, not vendored here.

## Testing after a change

```sh
~/.config/tmux/selftest.sh        # 25 checks; closes only empty tabs
~/.config/tmux/clicktest.py 1 3   # click sidebar rows 1 and 3
```
