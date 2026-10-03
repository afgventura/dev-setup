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
(`-L ui`, config `tmux/ui.conf`) is throwaway chrome: a `@sidebar_width`-column
pane (72 by default) running `sidebar.sh` (fzf as a pure display) next to a pane
that just attaches `main`.
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
fzf, so keyboard focus can't land in the sidebar. The sidebar is identified by
geometry — it is the pane at column 0 — in every mouse binding and focus hook;
`@sidebar`/`@content` (recorded by `ghostty-ui.sh` / `sidebar-ids.sh`) are only
for scripts and humans. A window resize, focus-in or (re)attach runs
`sidebar-redraw.sh`: it re-records those ids, restores the sidebar to
`@sidebar_width` and then does a full client redraw + fzf re-render, because fzf
sometimes came back with a blank list after the resize/resize-back pair.

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
launchd/                  LaunchAgents: vite-watchdog (kills agent-started Vite dev
                          servers every 5 s) and pi-package-update (extensions)
pi/pi-package-update.sh   keeps pi's extension packages current so the update banner stops
pi/                       pi coding agent: settings, models (context window), MCP servers, extensions
pi/build-fork.sh          builds afgventura/pi and installs it as the global pi
infra/remote-pi-relay/    Terraform: our Remote Pi relay on Cloud Run (Jakarta)
.agents/skills/           agent skills (.claude/skills/* are symlinks to them, for Claude Code)
```

## Tuning

- launchd jobs run their script directly, never `/bin/bash <script>`: macOS names
  a login item after the executable it launches, so the wrapper form showed up in
  System Settings → General → Login Items ("Allow in the Background") as `bash`,
  with no way to tell the two jobs apart. As a side effect the log's first column
  is the script, not the interpreter.

- Sidebar width: `@sidebar_width` in `tmux/ui.conf` (72) — the one place;
  `ghostty-ui.sh` (initial split), `sidebar-redraw.sh` (resize on attach/resize,
  clamped to leave ~40 columns) and `sidebar-list.sh` (row padding/truncation)
  all read it. `SIDEBAR_WIDTH=<n>` in the environment overrides it for the list
  (used by tests).
- Active-row colour: `bg+:#0969da` in `sidebar.sh`.
- MCP tokens for pi are read from env vars named in `pi/mcp.json`
  (`bearerTokenEnv`) — keep secrets in the Keychain and export them from your
  shell rc, e.g. `export X="$(security find-generic-password -a "$USER" -s "haloai-shell:X" -w)"`.

## Guards (this machine only, not the repo)

`claude/guard-search.sh` is the PreToolUse hook for Claude Code and Codex, and
`pi/extensions/guard-search.ts` the same rules for pi. Besides the slow-search
rules it refuses local dev servers: any `vite`/`vite dev`/`--host`/`--port`,
`pnpm dev`, or a command that sets `HALOAI_ALLOW_VITE_DEV` (the escape hatch
`apps/web/vite.config.ts` names in its own error, which agents read and use).
`scripts/generate-routes.sh` and `apps/wifi-e2e/scripts/dev-server.sh` stay
allowed by name. A hook only sees command text, so `tmux/vite-watchdog.sh`
(launchd `com.gery.vite-watchdog`, every 5 s) kills any Vite dev server whose
ancestry isn't one of those two scripts — `vite build`/`preview` are left
alone. Kills are logged to `~/.local/state/vite-watchdog.log`.

## pi

Subagents run as **slim child pi processes**, not in-process SDK sessions
(`pi/extensions/pi-subagents-local.ts`). `@tintinweb/pi-subagents` is no longer in the
package list: its agents were sessions inside the parent, so every agent's bookkeeping,
parsing, assembly and rendering shared the session's one event loop, and anything an agent
leaked stayed in the parent for the life of the session (a 7h session was found holding
1,768 leaked socketpairs, burning ~25% of a core with no I/O).

The replacement speaks the same `subagents:rpc` v2 protocol that cc-my-pi's `pi-tasks`
expects — `ping` returns `{version: 2}`, `spawn` returns an id and later emits
`subagents:completed`/`:failed`, `stop` SIGTERMs the child — so cc-my-pi's task layer keeps
working unchanged. Each agent is launched as:

```
<command> <commandArgs> --mode rpc --session-dir <tmp>/pi-subagents-local/<id> \
  --no-extensions --no-skills --no-prompt-templates --tools read,grep,find,ls,bash,edit,write
```

It drives the child over pi's documented `--mode rpc` JSONL protocol (`docs/rpc.md`) rather
than through any host module, so it does not break when pi's internal API moves.

**Portable, not pinned to one machine.** There is no hardcoded path, user, checkout or
install layout anywhere in it:

- the child command is auto-detected and overridable — unset, children are the *same* build
  as the parent (a JS entry from `process.argv[1]` run with node, which covers a source
  checkout, an npm install, or the global `pi` shim), falling back to `process.execPath`,
  which is how a compiled/standalone pi re-invokes itself. Override with the config's
  `command`/`commandArgs`, or `PI_SUBAGENTS_LOCAL_COMMAND` / `PI_SUBAGENTS_LOCAL_CLI`;
- the config file is found at `$PI_SUBAGENTS_LOCAL_CONFIG`, else
  `$PI_CODING_AGENT_DIR/subagents-local.json`, else `~/.pi/agent/subagents-local.json`;
- child session files go under the OS temp dir;
- every flag a child gets is configurable, so a host whose pi differs adjusts config instead
  of editing the extension.

Children are ~35 MB RSS instead of ~361 MB inheriting 9 MCP servers, they use real cores for
their own JS work, and their leaks die with the process. Verified on the fork: 17 agents
against a cap of 16 held **exactly 16 concurrent children** (largest 140 MB) and finished in
15.1 s where serial would be ≥85 s; 4 agents doing `sleep 3` finished in 6.7 s; `stop` leaves
no orphan and frees its slot; a live session's `TaskExecute` ran a child end to end.
`pi/subagents-local.json` (merged into the agent dir by `install.sh`) sets:

| key | default | meaning |
| --- | --- | --- |
| `tools` | read, grep, find, ls, bash, edit, write | tools each child gets |
| `maxConcurrent` | 16 | fan-out cap; extras queue |
| `timeoutMs` | 1800000 | per-agent wall-clock limit |
| `model` / `provider` | unset | child model; unset = host default |
| `extensions` | false | true = children also load extensions/MCP |
| `sessionDir` | `<tmp>/pi-subagents-local` | where child sessions are written, or `null` |
| `command` / `commandArgs` | auto | override how a child is launched |
| `extraArgs` | `[]` | appended last, for host pi version differences |

Children keep their own session file under `<sessionDir>/<id>/`, which is what to read when an
agent's returned summary is not enough. On another machine: clone this repo and run
`install.sh pi`, or copy the single `pi-subagents-local.ts` plus `pi/subagents-local.json`
into that host's agent dir — nothing else is required.

`pi/settings.json` lists the packages pi installs on first run
(`cc-my-pi`, `pi-mcp-adapter`, ralph loop, …).
`pi-mcp-adapter` is pinned to `^5.0.0`: an unpinned entry resolves to npm's
`latest` on every `pi update`, so pin it and bump it deliberately. 5.x is the
line that reads pi's own `mcp.json` instead of warning that it "no longer reads"
it; 3.x warned on every start and pi 1.0.0 cannot silence that. 4.0.0+ also
defaults `mcpScript` off, so `pi/mcp-adapter.json` (merged into
`~/.pi/agent/mcp-adapter.json`) carries `settings.scriptMode: true` to keep it.
`pi/build-fork.sh` builds `afgventura/pi` and installs it as the global `pi`. This is how the
fork is meant to be installed; `install.sh pi` only installs upstream's npm build when no pi
exists yet, and until `build-fork.sh` runs that npm build is what a bare `pi` starts, whatever
the fork contains. Two things exist only in the fork:

- `transcriptMaxLines` (default 20000): the transcript keeps just the tail of what it has
  rendered. Upstream lays out the entire transcript on every frame, so a long session costs its
  whole history per keystroke or streamed token — measured on a 48 MB session (5,986 items,
  ~1.5M lines) 81 ms per warm frame and 17 s for the first render, against 2.6 ms and 8 ms with
  the window. `/settings` → "Transcript line limit"; `0` keeps everything.
- `set_cwd`, backgrounded long shell commands, an indexed session picker, and the
  `quietExtensionWarnings` gate below.

`PI_FORK_REF` (default `perf/transcript-window`), `PI_FORK_DIR` (default `~/Workspace/pi`),
`PI_BIN` (default `/usr/local/bin/pi`) and `SKIP_LINK=1` override the defaults. It prefers a
local branch over `origin`, so a dev machine never loses commits that are ahead of the remote,
refuses to build over uncommitted work unless the Mac's staging dir
`/tmp/pi-stage` (`npmrc`, `wip.patch`, `untracked.tgz`) is present, refuses to touch the
`/opt/cmx/agents` multiplexer (that wrapper forwards to `/usr/local/bin/pi` anyway), and fails
before installing if the freshly built bundle lacks the fork's markers — silently wrapping the
upstream build is the failure mode this repo has already hit twice. Back to npm's build:
`ln -sfn ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi`.

`pi/patches/quiet-extension-warnings.mjs` is linked to `~/.pi/agent/patches/` and
run by `install.sh pi`: it ports the fork's `quietExtensionWarnings` gate into an
*npm-installed* pi, because upstream pi 1.0.0 has no such setting and always renders
startup diagnostics, so its extension-manifest warnings cannot be silenced any
other way. `pi update` reinstalls the package and drops the patch — re-run the
script (or `./install.sh pi`). Once `build-fork.sh` has run the patch is redundant
but still safe: the fork implements the gate itself, and the patch skips its own edit
when it finds it already present, so `install.sh pi` can be re-run either way.

`pi/pi-package-update.sh` (launchd `com.gery.pi-package-update`, at login and
every 12 h) runs `pi update --extensions`, so the "Package Updates Available"
banner stops appearing. Extensions only: a plain `pi update` would self-update
pi and drop the patch above. It also clears pi's cached update check
(`~/.pi/agent/package-update-check.json`) when that cache lists something — the
banner reads the cache, and pi only refreshes it once a day, so without this it
keeps naming packages that are already current; a clean cache is left alone
because it is what saves the ~2.9 s check at startup. A version range in
`pi/settings.json` still moves within its range (`@^5.0.0` takes the newest
5.x); only a fully exact version is left alone by pi itself. Log:
`~/.local/state/pi-package-update.log`, and only when something changed or
failed. Run it by hand with `~/.config/pi/pi-package-update.sh`, or:
`launchctl kickstart gui/$UID/com.gery.pi-package-update`.

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
`pi/extensions/goal.ts` is the session goal, modelled on Codex's per-thread goal:
`/goal [<objective>|clear|edit|pause|resume]` plus the `create_goal` /
`update_goal` / `get_goal` tools, one goal per session, kept as a `goal` entry
on the session branch so it survives resume and follows `/tree`. While a goal is
active it asks for one more turn each time a run settles — Codex's goal
continuation — stopping on complete / blocked / paused / budget-limited, or
after `PI_GOAL_MAX_CONTINUATIONS` (50) automatic turns without user input. It
replaces `pi-goal-x`, whose goals lived in the project (`.pi/goals/`) and were
shared by every session there, so each session had to be pointed at one with
`/goal-focus`.
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
It also ignores in-process pi-subagents child sessions (no UI bound, name
`<agent>#<id>`), which otherwise re-fired its handlers and renamed the tab to
`general purpose 3f8a8d01` every time the orchestrator spawned a worker.
`pi/models.json` caps deepseek-v4.1-flash and both muse-spark contributor models at a 500k window (of their nominal 1M) so
auto-compaction and the ctx meter both work off 500k — cost isn't the constraint
at $0.003/M cached input; long-context quality and latency are.
`tuiMode: fullscreen` renders only the visible part of the transcript on its
own screen; the default inline mode re-prints the whole transcript through
tmux on every resume, which is what made resuming a long session slow and
flickery. `PI_SKIP_VERSION_CHECK=1` in the shell rc skips the network version
check at startup (~0.8 s); run `pi update` yourself now and then (extensions are
kept current by the daemon below).
`enabledModels` scopes the catalogue to exact `provider/model` entries
(deepseek-v4.1-flash on opencode-go, the GPT models on openai-codex). Without
it a bare model name like `gpt-5.6-luna` — which AGENTS.md tells subagents to
use — resolved to opencode-go's copy and was billed there instead of to the
ChatGPT subscription. Log in once with `/login` → OpenAI Codex.
`byteplus/deepseek-v4-1-flash-260910` (BytePlus Ark,
`https://ark.ap-southeast.bytepluses.com/api/v3`) is the default provider and model, and
`modelThinkingLevels` pins it to `medium`; Ark takes a reasoning-effort knob
(`supportsReasoningEffort`), so `medium` is a real step there and pi does not clamp it
away. Its key is deliberately not in `models.json`: pi resolves the `byteplus` credential
from `auth.json` (`/login`) or the provider's environment variable, so a new machine needs
that key supplied once before the default model will answer.
`opencode-go-2` is opencode-go again under a second API key (Keychain item
`haloai-shell:OPENCODE_GO_2_API_KEY`, read with `!security …` at request time),
mirroring the models we use so two accounts can be billed separately. Note the
Responses-API models (muse-spark, gpt-5.6-luna) store encrypted reasoning items
that are bound to the key that issued them: changing a provider's key under a
running session yields `reasoning encrypted_content was not issued to this
caller`. pi only replays those items when provider *and* model match, so the
fix is to switch the session to the other provider id (`/model
opencode-go-2/<same model>`), which drops the stale items — never swap the key
in place.
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
`pi/extensions/tab-status.ts` puts a state glyph in front of the pi tab name,
like Claude Code's: `⋯ name` = a turn is running, `◔ name` = idle but something
will wake it (a `/loop` or `schedule_wakeup` timer, a `background_run`/`watch`
task, a background subagent), bare `name` = done until you type. `/waiting`
lists what is armed. loop.ts and tasks.ts publish their armed state through a
`globalThis.__piWaits` registry; subagents come from pi-subagents' events.
`fullscreenWheelScrollLines` is 5 in `pi/settings.json` — the same step as tmux
copy-mode in other panes, Alt+wheel still multiplies by 5. `pi/extensions/wheel.ts`
used to force that by wrapping `TuiAltScreen.routeWheel`, from when pi hard-coded
1 line per event and repainted the whole screen per event (upstream #9052 / #9549).
1.0.0 took the knob natively — `fullscreenWheelScrollLines`, settable in
`/settings` — and widened `routeWheel` to `(event, delta)`, so the one-argument
wrapper passed an undefined delta and the transcript stopped scrolling altogether.
The extension is gone.
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
