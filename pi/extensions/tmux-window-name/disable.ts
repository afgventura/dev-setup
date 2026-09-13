export const DISABLE_ENV_VAR = "PI_TMUX_WINDOW_NAME_DISABLED";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isTmuxWindowNameExtensionDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[DISABLE_ENV_VAR]?.trim().toLowerCase();
  if (!value) return false;
  return TRUE_VALUES.has(value);
}
