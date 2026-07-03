export type OpenClawAgentRunner = "auto" | "wsl" | "native" | "provider-direct";
export type OpenClawEffectiveRunner = "wsl" | "native" | "provider-direct";

export function normalizeOpenClawAgentRunner(value: string | null | undefined): OpenClawAgentRunner {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "wsl" || normalized === "native" || normalized === "provider-direct" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

export function resolveOpenClawAgentRunner(input: {
  runner?: OpenClawAgentRunner | string | null;
  platform?: string | null;
} = {}): OpenClawEffectiveRunner {
  const runner = normalizeOpenClawAgentRunner(input.runner);
  if (runner === "provider-direct" || runner === "wsl" || runner === "native") {
    return runner;
  }

  const runtimePlatform =
    input.platform ??
    (globalThis as { process?: { platform?: string } }).process?.platform ??
    "";
  return runtimePlatform === "win32" ? "wsl" : "native";
}
