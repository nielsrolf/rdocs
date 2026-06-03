import { spawn } from "node:child_process";
import path from "node:path";

// Untrusted widget builds. The agent authors a `build_cmd` (e.g. `python
// widgets/build_fft.py`) that must run to produce the embeddable artifact. This
// is arbitrary code execution, so it MUST run inside the agent's sandbox — never
// on the app host. Lives in agent-core so the container entrypoint runs it; the
// app re-exports it (see lib/research-workspace.ts) for the in-process fallback
// and the manual widget-refresh routes.

export function parseBuildCommand(buildCmd: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (const char of buildCmd.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) {
    return null;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens.length > 0 ? tokens : null;
}

export function validateWidgetBuildCommand(tokens: string[], cwd: string) {
  const executable = tokens[0];
  if (!executable || executable.includes("/") || executable.includes("\\")) {
    return "Widget build command must start with an executable name such as python, node, sh, bash, npm, or npx.";
  }

  const allowedExecutables = new Set(["python", "python3", "node", "sh", "bash", "npm", "npx"]);
  if (!allowedExecutables.has(executable)) {
    return `Widget build executable "${executable}" is not allowed.`;
  }

  const workspaceRoot = path.resolve(cwd);
  for (const token of tokens.slice(1)) {
    if (!token || token.startsWith("-") || /^[A-Za-z0-9_./:=,@+-]+$/.test(token)) {
      continue;
    }
    return `Widget build argument contains unsupported characters: ${token}`;
  }

  const scriptToken = tokens.find((token) => /(^|\/)widgets\/.+\.(py|js|mjs|cjs|sh)$/i.test(token));
  if (scriptToken) {
    const scriptPath = path.resolve(cwd, scriptToken);
    if (!scriptPath.startsWith(`${workspaceRoot}${path.sep}`)) {
      return "Widget build script must be inside the repository workspace.";
    }
  }

  return null;
}

export async function runWidgetBuild(buildCmd: string, cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const tokens = parseBuildCommand(buildCmd);
  if (!tokens) {
    return { ok: false, error: "Widget build command could not be parsed." };
  }

  const validationError = validateWidgetBuildCommand(tokens, cwd);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  return new Promise((resolve) => {
    const [command, ...args] = tokens;
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: process.env
    });
    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: "Widget build timed out after 120 seconds." });
    }, 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const message = (stderr || stdout || `Widget build exited with code ${code}`).trim();
        resolve({ ok: false, error: message });
        return;
      }
      resolve({ ok: true });
    });
  });
}
