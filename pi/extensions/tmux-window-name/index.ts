import { completeSimple, type UserMessage } from "@earendil-works/pi-ai";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { isTmuxWindowNameExtensionDisabled } from "./disable.ts";
import { buildRenameWindowArgs, resolveTmuxWindowTarget } from "./tmux-window-target.ts";

const WINDOW_WORD_MIN = 3;
const WINDOW_WORD_MAX = 4;
const SESSION_WORD_MIN = 8;
const SESSION_WORD_MAX = 12;
const SESSION_CHAR_MAX = 96;
const REQUEST_TIMEOUT_MS = 30_000;
const NAMING_SOURCE_CHAR_MAX = 4000;
const WINDOW_NAME_ENTRY_TYPE = "pi-tmux-window-name/window";

type NamingSource = "user_message" | "conversation";
type RenameFailureReason =
  | "missing_prompt"
  | "missing_model"
  | "missing_auth"
  | "request_failed"
  | "invalid_output"
  | "skipped"
  | "stale_session";

type GenerateNamesResult =
  | { ok: true; names: GeneratedNames }
  | {
      ok: false;
      reason: Exclude<RenameFailureReason, "skipped" | "stale_session">;
    };

type RenameResult =
  | { ok: true; names: GeneratedNames }
  | {
      ok: false;
      reason: RenameFailureReason;
    };

// Vendored from npm:pi-tmux-window-name (Apache-2.0, default-anton) with the
// reasoning/maxTokens fix above. See LICENSE alongside.
const WINDOW_AND_SESSION_PROMPT = `You generate names for coding sessions.

Return exactly two lines:
WINDOW: <3-4 words>
SESSION: <8-12 words>

Rules:
- Keep both names specific to the user's task.
- Use plain letters and numbers only.
- Use spaces between words. No punctuation.
- Use sentence case (capitalize only the first word unless a word is already mixed-case or all caps).
- No quotes, markdown, emojis, labels beyond WINDOW:/SESSION:, or explanations.
- The session name should be descriptive enough for quickly scanning a session list.

Examples:
WINDOW: Fix OAuth callback logic
SESSION: Implement OAuth callback validation and retry flow in auth service`;

type GeneratedNames = {
  windowName: string;
  sessionName: string;
};

function normalizeWords(value: string): string[] {
  return value
    .replace(/[\n\r\t]+/g, " ")
    .replace(/["'`“”‘’]/g, " ")
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function compactWindowName(value: string, minWords = WINDOW_WORD_MIN): string | undefined {
  const words = normalizeWords(value).slice(0, WINDOW_WORD_MAX);
  if (words.length < minWords) return undefined;

  const name = words.join(" ").trim();
  return name || undefined;
}

function compactSessionName(value: string, minWords = SESSION_WORD_MIN): string | undefined {
  const words = normalizeWords(value).slice(0, SESSION_WORD_MAX);
  if (words.length < minWords) return undefined;

  while (words.length > minWords && words.join(" ").length > SESSION_CHAR_MAX) {
    words.pop();
  }

  const name = words.join(" ").trim();
  if (!name) return undefined;
  if (name.length <= SESSION_CHAR_MAX) return name;
  return name.slice(0, SESSION_CHAR_MAX).trim() || undefined;
}

// pi-subagents names a child session `<agent>#<first 8 chars of its id>`
// (agent-runner.ts: `${baseSessionName}#${agentId.slice(0, 8)}`).
function isSubagentSessionName(name: string | undefined): boolean {
  return !!name && /#[0-9a-f]{8}$/i.test(name);
}

function cleanGeneratedValue(value: string): string {
  return value.replace(/^[\s"'`]+|[\s"'`]+$/g, "").trim();
}

function parseGeneratedNames(value: string): { window?: string; session?: string } {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let windowName: string | undefined;
  let sessionName: string | undefined;

  for (const line of lines) {
    if (!windowName) {
      const windowMatch = line.match(/window\s*:\s*(.*?)(?=\bsession\s*:|$)/i);
      if (windowMatch?.[1]) {
        windowName = cleanGeneratedValue(windowMatch[1]);
      }
    }

    if (!sessionName) {
      const sessionMatch = line.match(/session\s*:\s*(.*)$/i);
      if (sessionMatch?.[1]) {
        sessionName = cleanGeneratedValue(sessionMatch[1]);
      }
    }

    if (windowName && sessionName) {
      break;
    }
  }

  return { window: windowName, session: sessionName };
}

function getStoredWindowName(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;
    if (entry.customType !== WINDOW_NAME_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") continue;

    const candidate = (entry.data as Record<string, unknown>).windowName;
    if (typeof candidate !== "string") continue;

    const normalized = compactWindowName(candidate, 1);
    if (normalized) return normalized;
  }

  return undefined;
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part,
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getFirstUserPrompt(entries: SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user") continue;

    const text = extractTextFromMessageContent(entry.message.content);
    if (text) return text;
  }

  return undefined;
}

function buildConversationNamingSource(entries: SessionEntry[]): string | undefined {
  const messages: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractTextFromMessageContent(entry.message.content);
    if (!text) continue;

    messages.push(`<${role}>\n${text}\n</${role}>`);
  }

  const conversation = messages.join("\n\n").trim();
  return conversation || undefined;
}

function formatNamingPrompt(seed: string, source: NamingSource): string {
  const tag = source === "conversation" ? "conversation" : "user_message";
  const content = seed.trim().slice(0, NAMING_SOURCE_CHAR_MAX);

  return `<${tag}>\n${content}\n</${tag}>\n\nRespond now using exactly this format:\nWINDOW: 3-4 words\nSESSION: 8-12 words`;
}

async function renameCurrentTmuxWindow(
  pi: ExtensionAPI,
  name: string,
  targetWindow?: string,
): Promise<boolean> {
  if (!process.env.TMUX) return false;

  try {
    const result = await pi.exec("tmux", buildRenameWindowArgs(name, targetWindow));
    return result.code === 0;
  } catch {
    return false;
  }
}

async function generateNames(
  prompt: string,
  source: NamingSource,
  ctx: ExtensionContext,
): Promise<GenerateNamesResult> {
  const seed = prompt.trim();
  if (!seed) {
    return { ok: false, reason: "missing_prompt" };
  }

  if (!ctx.model) {
    return { ok: false, reason: "missing_model" };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) {
    return { ok: false, reason: "missing_auth" };
  }

  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: formatNamingPrompt(seed, source) }],
    timestamp: Date.now(),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await completeSimple(
      ctx.model,
      {
        systemPrompt: WINDOW_AND_SESSION_PROMPT,
        messages: [message],
      },
      {
        apiKey: auth.apiKey,
        headers: { ...providerSessionHeaders(ctx), ...(auth.headers ?? {}) },
        // Reasoning models (e.g. deepseek-v4.1-flash at "high") spend a small
        // budget on thinking and return nothing parseable: keep reasoning
        // minimal and leave headroom for it.
        reasoning: "minimal",
        maxTokens: 1024,
        signal: controller.signal,
      },
    );
  } catch {
    return { ok: false, reason: "request_failed" };
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.stopReason === "error") {
    return { ok: false, reason: "request_failed" };
  }
  const generated = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  const parsed = parseGeneratedNames(generated);
  const windowName = compactWindowName(parsed.window ?? "");
  const sessionName = compactSessionName(parsed.session ?? "");

  if (!windowName || !sessionName) {
    return { ok: false, reason: "invalid_output" };
  }

  return { ok: true, names: { windowName, sessionName } };
}


// opencode / opencode-go reject requests without a session id header; pi's
// own agent loop adds these (core/provider-attribution), direct calls must too.
function providerSessionHeaders(ctx: ExtensionContext | ExtensionCommandContext): Record<string, string> {
  const provider = ctx.model?.provider ?? "";
  const baseUrl = (ctx.model as { baseUrl?: string } | undefined)?.baseUrl ?? "";
  if (provider !== "opencode" && provider !== "opencode-go" && !baseUrl.includes("opencode.ai")) return {};
  const sessionId = ctx.sessionManager.getSessionId();
  return sessionId ? { "x-opencode-session": sessionId, "x-opencode-client": "pi" } : {};
}

function describeRenameFailure(reason: RenameFailureReason): string {
  switch (reason) {
    case "missing_prompt":
      return "No user or assistant text found in the current branch.";
    case "missing_model":
      return "No active model is selected for generating a session name.";
    case "missing_auth":
      return "No request auth is available for the active model.";
    case "request_failed":
      return "Session rename request failed.";
    case "invalid_output":
      return "The model returned an invalid session name format.";
    case "stale_session":
      return "Session changed before rename completed.";
    case "skipped":
      return "Session rename was skipped.";
  }
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "error") {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, level);
}

export default function tmuxWindowNameExtension(pi: ExtensionAPI) {
  if (isTmuxWindowNameExtensionDisabled()) {
    return;
  }

  let hasNameForSession = false;
  let hasAttemptedNameForSession = false;
  let renameInFlight: Promise<RenameResult> | null = null;
  let sessionEpoch = 0;
  let tmuxWindowTarget: string | undefined;
  let tmuxWindowTargetInFlight: Promise<string | undefined> | null = null;

  const resetSessionState = () => {
    sessionEpoch += 1;
    hasNameForSession = false;
    hasAttemptedNameForSession = false;
    renameInFlight = null;
    tmuxWindowTarget = undefined;
    tmuxWindowTargetInFlight = null;
  };

  const captureTmuxWindowTarget = async (): Promise<string | undefined> => {
    if (tmuxWindowTarget) return tmuxWindowTarget;
    if (tmuxWindowTargetInFlight) return tmuxWindowTargetInFlight;

    const work = resolveTmuxWindowTarget((command, args) => pi.exec(command, args))
      .then((target) => {
        tmuxWindowTarget = target;
        return target;
      })
      .finally(() => {
        if (tmuxWindowTargetInFlight === work) {
          tmuxWindowTargetInFlight = null;
        }
      });

    tmuxWindowTargetInFlight = work;
    return work;
  };

  const persistNames = async (names: GeneratedNames, targetWindow?: string) => {
    pi.setSessionName(names.sessionName);
    pi.appendEntry(WINDOW_NAME_ENTRY_TYPE, { windowName: names.windowName });
    await renameCurrentTmuxWindow(pi, names.windowName, targetWindow);
    hasNameForSession = true;
    hasAttemptedNameForSession = true;
    // remote-pi (phone app) shows agents by their mesh name, which defaults
    // to the folder name — give it the same title as the tab
    if (pi.getCommands().some((c) => c.name === "remote-pi rename")) {
      runSlashCommand(`/remote-pi rename ${names.windowName}`);
    }
  };

  // Run a slash command exactly as if the user typed it: through the live
  // editor's submit path. (pi.sendUserMessage always starts a model turn,
  // even for a bare command, which produced a spurious extra reply.)
  let liveEditor: any;
  pi.on("session_start", async (_event, ctx) => {
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const ed: any = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      liveEditor = ed;
      return ed;
    });
  });
  const runSlashCommand = (command: string) => {
    if (!liveEditor?.setText || !liveEditor?.handleInput) return false;
    const saved: string = liveEditor.getText?.() ?? "";
    liveEditor.setText(command);
    liveEditor.handleInput("\r");
    if (saved) liveEditor.setText(saved);
    return true;
  };

  const runRename = async (
    prompt: string | undefined,
    source: NamingSource,
    ctx: ExtensionContext,
    options?: { force?: boolean },
  ): Promise<RenameResult> => {
    const force = options?.force ?? false;

    if (!force && (hasNameForSession || hasAttemptedNameForSession || renameInFlight)) {
      return { ok: false, reason: "skipped" };
    }

    const seed = prompt?.trim();
    if (!seed) {
      return { ok: false, reason: "missing_prompt" };
    }

    if (!force) {
      hasAttemptedNameForSession = true;
    }

    const currentEpoch = sessionEpoch;
    const work = (async (): Promise<RenameResult> => {
      const targetWindow = await captureTmuxWindowTarget();
      const result = await generateNames(seed, source, ctx);
      if (!result.ok) {
        return result;
      }

      if (currentEpoch !== sessionEpoch) {
        return { ok: false, reason: "stale_session" };
      }

      await persistNames(result.names, targetWindow);
      return { ok: true, names: result.names };
    })();

    const inFlight = work.finally(() => {
      if (renameInFlight === inFlight) {
        renameInFlight = null;
      }
    });

    renameInFlight = inFlight;
    return inFlight;
  };

  const applyAutoName = async (seedPrompt: string | undefined, ctx: ExtensionContext): Promise<void> => {
    const targetWindow = await captureTmuxWindowTarget();
    const existing = pi.getSessionName();
    if (existing) {
      const restoredWindow = getStoredWindowName(ctx.sessionManager.getBranch()) ?? compactWindowName(existing, 1) ?? existing;
      await renameCurrentTmuxWindow(pi, restoredWindow, targetWindow);
      hasNameForSession = true;
      hasAttemptedNameForSession = true;
      return;
    }

    await runRename(seedPrompt, "user_message", ctx);
  };

  const restoreExistingSessionName = async (ctx: ExtensionContext) => {
    const existing = pi.getSessionName();
    if (!existing) return;

    const targetWindow = await captureTmuxWindowTarget();
    const storedWindow = getStoredWindowName(ctx.sessionManager.getBranch());
    const windowName = storedWindow ?? compactWindowName(existing, 1) ?? existing;
    await renameCurrentTmuxWindow(pi, windowName, targetWindow);
    hasNameForSession = true;
    hasAttemptedNameForSession = true;
    // remote-pi keeps one agent_name per folder, so a resumed session would
    // otherwise come up under whatever name the last session in this folder
    // set. Re-apply this session's title once remote-pi has joined the mesh
    // (its auto-start runs from its own session_start handler).
    if (pi.getCommands().some((c) => c.name === "remote-pi rename")) {
      setTimeout(() => runSlashCommand(`/remote-pi rename ${windowName}`), 3000);
    }
  };

  const renameFromBranch = async (args: string, ctx: ExtensionCommandContext) => {
    const custom = args.trim();
    if (custom) {
      // `/rename <name>`: use the given name verbatim (tab, session, remote-pi)
      // instead of generating one. Auto-naming stays off for this session.
      if (renameInFlight) await renameInFlight;
      const targetWindow = await captureTmuxWindowTarget();
      await persistNames({ windowName: custom, sessionName: custom }, targetWindow);
      notify(ctx, `Renamed session: ${custom}`, "info");
      return;
    }

    await ctx.waitForIdle();

    if (renameInFlight) {
      await renameInFlight;
    }

    const conversation = buildConversationNamingSource(ctx.sessionManager.getBranch());
    const result = await runRename(conversation, "conversation", ctx, { force: true });

    if (!result.ok) {
      notify(ctx, describeRenameFailure(result.reason), "error");
      return;
    }

    notify(ctx, `Renamed session: ${result.names.sessionName}`, "info");
  };

  pi.registerCommand("rename", {
    description: "/rename <name> sets the tab/session name; bare /rename regenerates it from the conversation",
    handler: renameFromBranch,
  });

  // pi-subagents runs subagents in-process: each child session binds every
  // extension and carries its own name (`general-purpose#3f8a8d01`), so these
  // handlers fire again inside the same tmux window and would rename the tab
  // after the child, and reset the parent's "already named" state. A child
  // session has no UI bound (`hasUI` is false); only the interactive parent
  // owns the tab name. Headless `pi -p` runs lose auto-naming too, which is
  // fine — those windows are transient.
  const ownsTab = (ctx: ExtensionContext): boolean => ctx.hasUI && !isSubagentSessionName(pi.getSessionName());

  pi.on("session_start", async (_event, ctx) => {
    if (!ownsTab(ctx)) return;
    resetSessionState();
    await restoreExistingSessionName(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!ownsTab(ctx)) return;
    const firstPrompt = getFirstUserPrompt(ctx.sessionManager.getBranch()) ?? event.prompt;
    void applyAutoName(firstPrompt, ctx);
  });
}
