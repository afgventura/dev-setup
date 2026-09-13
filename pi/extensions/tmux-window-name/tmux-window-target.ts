export type TmuxExecResult = {
  code: number;
  stdout?: string;
};

export type TmuxExec = (command: string, args: string[]) => Promise<TmuxExecResult>;

function normalizeTarget(value: string | undefined): string | undefined {
  const target = value?.trim();
  return target || undefined;
}

export function buildRenameWindowArgs(name: string, target?: string): string[] {
  return target ? ["rename-window", "-t", target, name] : ["rename-window", name];
}

export async function resolveTmuxWindowTarget(
  exec: TmuxExec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!env.TMUX) return undefined;

  const pane = normalizeTarget(env.TMUX_PANE);
  if (!pane) return undefined;

  try {
    const result = await exec("tmux", ["display-message", "-p", "-t", pane, "#{window_id}"]);
    if (result.code !== 0) return undefined;
    return normalizeTarget(result.stdout);
  } catch {
    return undefined;
  }
}
