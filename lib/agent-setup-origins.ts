export function allowedAgentSetupOrigins(): Set<string> {
  return new Set(
    (process.env.AGENT_SETUP_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean)
  );
}

export function isAllowedAgentSetupUrl(value: string): boolean {
  try {
    return allowedAgentSetupOrigins().has(new URL(value).origin);
  } catch {
    return false;
  }
}
