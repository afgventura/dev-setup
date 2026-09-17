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
- A **left sidebar** listing tabs, clickable, **grouped by project folder**
  (`haloai-1`, `govisa`, …); names follow the agent's own terminal title
  (Claude Code sets one per task, so tabs relabel themselves).
  `▶` = active, `•` = new output since you last looked. Only the `main`
  session is listed — orchestrator worker sessions stay out of sight.
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
| ⌘⇧[ / ⌘⇧] | previous / next tab (in sidebar order) |
| ⌘S | full-screen tab picker (Esc closes) |
| ⌘R | rename tab (sticks until closed) |
| ⌘D / ⌘⇧D | split right / down |
| ⌘⌥ arrows | move between splits |
| ⌘⇧K | clear scrollback |
| Shift+Enter | newline in an agent prompt |
| ⌥Enter | pi: queue the message until the current turn ends (Enter while busy = steer it in mid-turn); ⌥↑ pulls a queued message back |
| ⌘⇧U | pick & open a URL from the current tab |
| ⇧⌘-click | open a link under the mouse (tmux owns plain clicks, so Ghostty needs ⇧) |
| mouse | click a sidebar row to switch; scroll; drag to select + copy (also inside Codex); drag split borders |

## How it works

Two tmux servers. `main` (default socket) holds your real tabs. `ui`
(`-L ui`, config `tmux/ui.conf`) is throwaway chrome: a 51-column pane running
`sidebar.sh` (fzf as a pure display) next to a pane that just attaches `main`.
It has no prefix, so every `C-b …` sequence Ghostty's ⌘ keybinds emit passes
straight through to `main`. When the last Ghostty client detaches, `ui` kills
itself; `main` lives on.

`sidebar-list.sh` produces the rows (target + display) and is the single
source of truth for the sidebar, its click handler and its cursor position.
Sidebar updates are event-driven: hooks in `tmux.conf` call
`sidebar-refresh.sh`, which POSTs a `reload-sync` to fzf over a unix socket.
Hooks fire in bursts (every agent's title spinner), so the refresh is
coalesced (lock + dirty flag; throttled only during a burst), skipped when the
rows didn't change, sends the cursor position in the same request as the
reload, and every
hook is wrapped in `>/dev/null 2>&1 || true` — tmux would otherwise pop a
failing hook's output over the active pane.
Clicks are handled by tmux (`MouseDown1Pane` → `sidebar-click.sh`), never by
fzf, so keyboard focus can't land in the sidebar. A window resize or focus-in
(switching Spaces does both) runs `sidebar-redraw.sh` — full client redraw +
fzf re-render — because fzf sometimes came back with a blank list after the
resize/resize-back-to-51 pair.

`agent-notify.sh` is the Claude Code `Stop`/`Notification` hook and Codex's
`notify` hook. It drops a JSON request into `~/.local/state/agent-notifier/queue`;
`Agent Notifier.app` (tiny Swift app, `agent-notifier/`) posts the banner and,
on click, runs `tmux select-window` + brings Ghostty forward. Suppressed when
Ghostty is frontmost and that tab is already active, and for agents running in
sessions other than `main` (orchestrator workers — their orchestrator sweeps
them; you'd have no tab to jump to).

## Layout

```
ghostty/config            font, theme, ⌘ keybinds (→ tmux prefix sequences)
tmux/tmux.conf            main server: bindings, title→tab-name rule, hooks
tmux/ui.conf              outer chrome: sidebar pane, mouse, focus rules
tmux/ghostty-ui.sh        Ghostty's `command`: builds the layout, attaches
tmux/sidebar*.sh          the sidebar: list (grouping), refresh, click, cursor helpers
tmux/copy-release.sh      drag-release: include the cursor cell tmux would otherwise drop
tmux/agent-notify.sh      notification hook (Claude Code + Codex)
tmux/selftest.sh          acceptance test (quits/relaunches Ghostty, ~25 s)
tmux/clicktest.py         injects real mouse bytes to test sidebar clicks
agent-notifier/           Swift source + build script for the notifier app
claude/hooks.json         hook entries merged into ~/.claude/settings.json
codex/config.snippet.toml notify hook + shared Chrome MCP over HTTP
ssh/config.snippet        ControlMaster for github.com (fetch 3.2 s → 1.2 s)
pi/                       pi coding agent: settings, models (context window), MCP servers, extensions
infra/remote-pi-relay/    Terraform: our Remote Pi relay on Cloud Run (Jakarta)
.agents/skills/           agent skills (.claude/skills/* are symlinks to them, for Claude Code)
```

## Tuning

- Sidebar width: `SIDEBAR_WIDTH` in `tmux/ghostty-ui.sh`, the `-x` in
  `tmux/ui.conf`, and the default `W` in `sidebar-list.sh`.
- Active-row colour: `bg+:#0969da` in `sidebar.sh`.
- MCP tokens for pi are read from env vars named in `pi/mcp.json`
  (`bearerTokenEnv`) — keep secrets in the Keychain and export them from your
  shell rc, e.g. `export X="$(security find-generic-password -a "$USER" -s "haloai-shell:X" -w)"`.

## pi

`pi/settings.json` lists the packages pi installs on first run
(`cc-my-pi`, `pi-mcp-adapter`, `pi-subagents` — required by cc-my-pi's `TaskExecute`, ralph loop, …).
`pi/extensions/loop.ts` adds `/loop [interval] <prompt>` like Claude Code's:
with an interval it fires on a fixed schedule; without one it is a self-paced
loop where the agent picks each delay by calling `schedule_wakeup` (30 s–24 h,
or `at: "00:00"` / ISO time for a fixed clock time; also
exposed as tools `loop_start` / `loop_stop`, so the agent can start a loop
itself instead of asking you to).
`pi/extensions/tasks.ts` adds Claude Code's background-task model: tools
`background_run` (detached command, agent is woken with the output when it
exits), `watch` (poll a command until its output matches a regex / exits 0,
then wake the agent), `task_output`, `task_stop`; `/tasks` and
`/watch [every 30s] [until <regex>] <cmd>` for humans. Logs live in
`~/.pi/agent/tasks/`.
`pi/extensions/skills-inline.ts` lets a prompt reference any number of skills
anywhere in the text, Claude Code style (`per /repo-safety and /testing, …`);
pi's own `/skill:name` only works as the first word and takes one skill. The
SKILL.md bodies go into context as one collapsed `📚 loaded skills` message
and the prompt stays exactly as typed. Typing `/` anywhere in the line pops
the skill picker (Tab/Enter inserts the name).
`pi/extensions/tmux-window-name/` is a vendored copy of `pi-tmux-window-name`
(auto-names the tmux tab from the first prompt; `/rename` regenerates,
`/rename <name>` sets your own) with two fixes: it
sends the `x-opencode-session` header opencode-go requires, and keeps reasoning
minimal so thinking models return a parseable name.
`pi/models.json` caps deepseek-v4.1-flash at a 500k window (of its nominal 1M) so
auto-compaction and the ctx meter both work off 500k — cost isn't the constraint
at $0.003/M cached input; long-context quality and latency are.
`tuiMode: fullscreen` renders only the visible part of the transcript on its
own screen; the default inline mode re-prints the whole transcript through
tmux on every resume, which is what made resuming a long session slow and
flickery. `PI_SKIP_VERSION_CHECK=1` in the shell rc skips the network version
check at startup (~0.8 s); run `pi update` yourself now and then.
`enabledModels` scopes the catalogue to exact `provider/model` entries
(deepseek-v4.1-flash on opencode-go, the GPT models on openai-codex). Without
it a bare model name like `gpt-5.6-luna` — which AGENTS.md tells subagents to
use — resolved to opencode-go's copy and was billed there instead of to the
ChatGPT subscription. Log in once with `/login` → OpenAI Codex.
`self-hosted/z-ai/glm-5.3-flash` is our own GLM 5.3 Flash behind the sgl-router
gateway (`http://10.184.0.50:9000/v1`, GKE ILB over Tailscale, $0). Its key is
read from Keychain at request time (`apiKey: "!security find-generic-password
… haloai-shell:SELF_HOSTED_LLM_API_KEY"`), so it doesn't depend on shell env;
store it once with `security add-generic-password -a "$USER" -s
haloai-shell:SELF_HOSTED_LLM_API_KEY -w "$(gcloud secrets versions access latest
--secret=SELF_HOSTED_LLM_API_KEY --project=halo-ai-469606)"`. pi reads
`models.json` only at startup (`/reload` doesn't touch the model catalogue), so
a session started before the provider existed has to be relaunched to see it.
`remote-pi` is the remote control (iOS app "Remote Pi"): `/remote-pi` in the
session you want to drive → `/remote-pi relay url https://remote-pi-relay-….a.run.app`
(our own, see `infra/remote-pi-relay/`) → scan the QR with the app. Peers are
paired with Ed25519 keys kept in `~/.pi/remote/` and the phone Keychain.
`pi/extensions/no-mesh.ts` blocks remote-pi's agent-network tools (`agent_send`,
`agent_request`, `list_peers`): one session broadcasting a status note landed in
every other session as a `[remote-pi:mesh-message]` that started a model turn
there. We use remote-pi for the phone only.
`pi/extensions/wheel.ts` sets the fullscreen mouse-wheel step to 5 lines per
event — the same step as tmux copy-mode in other panes (pi hard-codes 1 and repaints the whole screen per event — upstream #9052
/ #9549 — which is why a trackpad flick lagged); `/wheel N` tunes it, Alt still
multiplies by 5.
`~/.pi/settings.json` has `claudeHeaderEnabled: false` — cc-my-pi's startup
banner instantiates every extension a second time (a throwaway loader just to
count them), which left remote-pi bound to a dead API and broke `/remote-pi pair`;
it also costs startup time.
`pi/agents/general-purpose.md` is the one subagent type: pi-subagents' three
built-ins (general-purpose / Explore / Plan) are switched off
(`pi/subagents.json` → `disableDefaultAgents`), and any `subagent_type` the
orchestrator makes up falls back to it (`fallbackSubagent`). It is a parent
twin (all tools, same system prompt and skills) pinned to `model:
openai-codex/gpt-5.6-luna`, `thinking: medium` — frontmatter is authoritative
in pi-subagents, so the orchestrating model cannot pick another model for a
subagent. Linked into `~/.pi/agent/agents/`; a project-local
`.pi/agents/<name>.md` still wins.
Skills are provided by those packages, not vendored here.

## Skills

`.agents/skills/orchestrate-subagents/` is the orchestrator skill from the haloai repo:
one Codex/Claude session plans and fans work out to worker Codex sessions in
their own tmux sessions/worktrees (`scripts/codex-session.sh`), with briefs,
pushback rules, an adversarial-review stage and a closeout log. Workers run in
an isolated tmux server (`TMUX_TMPDIR` jail) so a worker's `tmux kill-session`
can never take down its siblings. `.claude/skills/orchestrate-subagents` is a
symlink to it so Claude Code sees the same skill. Copy both into another repo
to use it there.

## Search guard

Agents sometimes reach for recursive `grep` or `find`, which walk
`node_modules` and every worktree (millions of files here) while `rg`/`fd`
honour `.gitignore` and finish in under a second. `claude/guard-search.sh` is
a PreToolUse hook for the shell tool that rejects recursive grep and
directory-walking `find` (`-maxdepth 0-2` allowed) with a hint to use rg/fd.
The same protocol serves Claude Code (`claude/hooks.json`) and Codex
(`codex/hooks.json`, trusted once in the TUI); `pi/extensions/guard-search.ts`
does it for pi. Piped `grep`, `git grep`, and text inside quotes or heredocs
are untouched.

## Testing after a change

```sh
~/.config/tmux/selftest.sh        # 25 checks; closes only empty tabs
~/.config/tmux/clicktest.py 1 3   # click sidebar rows 1 and 3
```
