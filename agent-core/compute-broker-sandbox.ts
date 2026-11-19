import fs from "node:fs";
import path from "node:path";

// Sandbox-side half of the credential broker for compute providers
// (lib/credential-broker/providers.ts). The run env already routes every
// client; this writes the same routing into the sandbox's HOME, because a
// harness may start its shells without variables named like KEY or TOKEN
// (Codex does), and a Hugging Face client that then finds HF_ENDPOINT but no
// token would be refused by the broker even for a public model.
//
// Only the run's VIRTUAL token is written, never a real credential.

const VIRTUAL_MARK = "rdocs-vk-";
const GIT_INCLUDE_FILE = ".gitconfig-rdocs-compute";
const GITHUB_BROKER_URL_ENV = "RDOCS_GITHUB_BROKER_URL";

function gitConfigValue(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function hfTokenFile(home: string, env: Record<string, string | undefined>) {
  const explicit = env.HF_TOKEN_PATH?.trim();
  if (explicit) return explicit;
  const hfHome = env.HF_HOME?.trim() || path.join(env.XDG_CACHE_HOME?.trim() || path.join(home, ".cache"), "huggingface");
  return path.join(hfHome, "token");
}

/**
 * Bring the sandbox HOME in line with this run's env: the stand-in Hugging
 * Face token where huggingface_hub looks for a stored login, and git's route
 * to the broker. A stand-in left by an earlier run is replaced, or removed
 * when this run has none (a dead stand-in would be sent to the real Hub and
 * fail requests that work anonymously).
 */
export function syncSandboxComputeBroker(home: string, agentEnv: Record<string, string | undefined>) {
  const tokenFile = hfTokenFile(home, agentEnv);
  const hfToken = agentEnv.HF_TOKEN?.trim() ?? "";
  try {
    if (hfToken.includes(VIRTUAL_MARK) && /^[A-Za-z0-9._-]+$/.test(hfToken)) {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, hfToken, { mode: 0o600 });
    } else if (fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, "utf8").includes(VIRTUAL_MARK)) {
      fs.rmSync(tokenFile, { force: true });
    }
  } catch {
    // A read-only or missing HOME: the env still routes the client.
  }

  // git: the GitHub bridge already writes every GIT_CONFIG_* entry when GitHub
  // is brokered (agent-core/github-broker-bridge.ts); otherwise do it here.
  try {
    const includePath = path.join(home, GIT_INCLUDE_FILE);
    const count = agentEnv[GITHUB_BROKER_URL_ENV]?.trim() ? 0 : Number.parseInt(agentEnv.GIT_CONFIG_COUNT ?? "0", 10) || 0;
    const lines: string[] = ["# Written by r-docs for this run. Replaced on every run."];
    for (let index = 0; index < count; index += 1) {
      const key = agentEnv[`GIT_CONFIG_KEY_${index}`];
      const value = agentEnv[`GIT_CONFIG_VALUE_${index}`];
      const match = key ? /^(url|http)\.(.+)\.(insteadOf|extraheader)$/i.exec(key) : null;
      if (!match || value === undefined || /[\r\n]/.test(`${key}${value}`)) continue;
      if (!match[2].includes("/api/broker/")) continue;
      lines.push(`[${match[1]} ${gitConfigValue(match[2])}]`, `\t${match[3]} = ${gitConfigValue(value)}`);
    }
    if (lines.length === 1) {
      if (fs.existsSync(includePath)) fs.writeFileSync(includePath, `${lines[0]}\n`, { mode: 0o600 });
      return;
    }
    fs.writeFileSync(includePath, `${lines.join("\n")}\n`, { mode: 0o600 });
    const gitconfig = path.join(home, ".gitconfig");
    const current = fs.existsSync(gitconfig) ? fs.readFileSync(gitconfig, "utf8") : "";
    if (!current.includes(GIT_INCLUDE_FILE)) {
      fs.appendFileSync(gitconfig, `[include]\n\tpath = ${includePath}\n`);
    }
  } catch {
    // As above.
  }
}
