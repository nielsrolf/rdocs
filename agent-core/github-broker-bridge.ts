// The `gh` CLI cannot be pointed at another base URL for github.com, but it can
// be told to make every HTTP request over a Unix socket (`http_unix_socket`),
// and then it speaks PLAIN HTTP on that socket with the real Host header.
//
// This module runs that socket inside the agent's own sandbox and forwards
// each request to r-docs' credential broker (lib/credential-broker), which is
// where the user's GitHub token is added. The sandbox only ever holds the
// run's virtual broker token, which stops working when the run ends.
//
// git does not need this: it is redirected with `url.<broker>.insteadOf`
// (GIT_CONFIG_* variables minted by the broker, lib/credential-broker/index.ts).

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const GITHUB_BROKER_URL_ENV = "RDOCS_GITHUB_BROKER_URL";
export const GITHUB_FORWARDER_HEADER = "x-rdocs-github-forwarder";

/** Which part of the broker's GitHub key a GitHub hostname maps to. */
export function githubBrokerSegmentForHost(hostHeader: string | undefined): string | null {
  const host = (hostHeader ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (host === "api.github.com") return "api";
  if (host === "uploads.github.com") return "uploads";
  if (host === "raw.githubusercontent.com") return "raw";
  if (host === "github.com" || host === "www.github.com") return "git";
  return null;
}

type Bridge = { socketPath: string; configDir: string; brokerUrl: string; server: http.Server };
// One bridge per broker key: each run has its own key, and in-process runs
// share this process.
const bridges = new Map<string, Bridge>();

function forward(bridgeState: Bridge, request: http.IncomingMessage, response: http.ServerResponse) {
  const segment = githubBrokerSegmentForHost(request.headers.host);
  if (!segment) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "Only GitHub hosts are reachable through the r-docs GitHub bridge." }));
    return;
  }
  const target = new URL(`${bridgeState.brokerUrl}/${segment}${request.url ?? "/"}`);
  const headers = { ...request.headers, host: target.host, [GITHUB_FORWARDER_HEADER]: "1" };
  const upstream = http.request(
    { protocol: target.protocol, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: request.method, headers },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    }
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: `r-docs GitHub bridge: broker unreachable (${error.message}).` }));
  });
  request.pipe(upstream);
}

/**
 * Make `gh` work with a brokered GitHub credential. Returns the env additions
 * for the agent (GH_CONFIG_DIR), or {} when this run has no brokered GitHub
 * access. Idempotent per broker key.
 */
export async function ensureGithubBrokerBridge(
  agentEnv: Record<string, string> | undefined,
  opts: {
    tmpDir?: string;
    /**
     * Inside a sandbox with its own HOME: gh's default config dir and the
     * user's git config file. Written so that gh and git work even for a
     * harness that does not pass GH_TOKEN / GIT_CONFIG_* on to its shell
     * (Codex drops variables named like KEY or TOKEN). Never pass the host's.
     */
    sandboxHome?: string;
  } = {}
): Promise<Record<string, string>> {
  const brokerUrl = agentEnv?.[GITHUB_BROKER_URL_ENV]?.trim().replace(/\/+$/, "");
  if (!brokerUrl) return {};
  const existing = bridges.get(brokerUrl);
  if (existing) return { GH_CONFIG_DIR: existing.configDir };
  // A Unix socket path is limited to ~107 bytes, so keep it short.
  const dir = fs.mkdtempSync(path.join(opts.tmpDir ?? os.tmpdir(), "rdocs-gh-"));
  fs.chmodSync(dir, 0o755);
  const socketPath = path.join(dir, "s");
  const configDir = opts.sandboxHome ? path.join(opts.sandboxHome, ".config", "gh") : path.join(dir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.yml"),
    `# Written by r-docs. gh reaches GitHub through r-docs' credential broker.\nhttp_unix_socket: ${socketPath}\nprompt: disabled\n`
  );
  if (opts.sandboxHome) writeSandboxGithubConfig(opts.sandboxHome, configDir, agentEnv ?? {});
  const state: Bridge = { socketPath, configDir, brokerUrl, server: http.createServer() };
  state.server.on("request", (request, response) => forward(state, request, response));
  await new Promise<void>((resolve, reject) => {
    state.server.once("error", reject);
    state.server.listen(socketPath, () => resolve());
  });
  // Any process of the sandbox may use it (the agent's shell runs as another uid in some images).
  fs.chmodSync(socketPath, 0o777);
  // Never keep the process alive on its own.
  state.server.unref();
  bridges.set(brokerUrl, state);
  return { GH_CONFIG_DIR: configDir };
}

const GIT_INCLUDE_FILE = ".gitconfig-rdocs-github";

function gitConfigValue(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The same routing the run env carries in GIT_CONFIG_* and GH_TOKEN, as files
 * in the sandbox's HOME. Only the run's VIRTUAL token is written. The git part
 * goes to a file of its own that is replaced on every run, so a session
 * container that serves several runs never keeps a previous run's (dead) route.
 */
function writeSandboxGithubConfig(home: string, ghConfigDir: string, agentEnv: Record<string, string>) {
  const virtualToken = agentEnv.GH_TOKEN?.trim() || agentEnv.GITHUB_TOKEN?.trim();
  if (virtualToken && /^[A-Za-z0-9._-]+$/.test(virtualToken)) {
    fs.writeFileSync(
      path.join(ghConfigDir, "hosts.yml"),
      `github.com:\n    oauth_token: ${virtualToken}\n    git_protocol: https\n`,
      { mode: 0o600 }
    );
  }
  const count = Number.parseInt(agentEnv.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const lines: string[] = ["# Written by r-docs for this run. Replaced on every run."];
  for (let index = 0; index < count; index += 1) {
    const key = agentEnv[`GIT_CONFIG_KEY_${index}`];
    const value = agentEnv[`GIT_CONFIG_VALUE_${index}`];
    const match = key ? /^(url|http)\.(.+)\.(insteadOf|extraheader)$/i.exec(key) : null;
    if (!match || value === undefined || /[\r\n]/.test(`${key}${value}`)) continue;
    lines.push(`[${match[1]} ${gitConfigValue(match[2])}]`, `\t${match[3]} = ${gitConfigValue(value)}`);
  }
  fs.writeFileSync(path.join(home, GIT_INCLUDE_FILE), `${lines.join("\n")}\n`, { mode: 0o600 });
  const gitconfig = path.join(home, ".gitconfig");
  const current = fs.existsSync(gitconfig) ? fs.readFileSync(gitconfig, "utf8") : "";
  if (!current.includes(GIT_INCLUDE_FILE)) {
    fs.appendFileSync(gitconfig, `[include]\n\tpath = ${path.join(home, GIT_INCLUDE_FILE)}\n`);
  }
}

/** Stop the bridge of one run (by its env), or all of them. */
export async function stopGithubBrokerBridge(agentEnv?: Record<string, string>) {
  const only = agentEnv?.[GITHUB_BROKER_URL_ENV]?.trim().replace(/\/+$/, "");
  for (const [url, current] of [...bridges]) {
    if (only && url !== only) continue;
    bridges.delete(url);
    await new Promise<void>((resolve) => current.server.close(() => resolve()));
    current.server.closeAllConnections?.();
    fs.rmSync(path.dirname(current.socketPath), { recursive: true, force: true });
  }
}
