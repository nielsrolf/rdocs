// A minimal JSON-RPC-over-stdio client for `codex app-server`.
//
// WHY THIS EXISTS
// ---------------
// The public @openai/codex-sdk is a thin wrapper over `codex exec
// --experimental-json`: one OS process per turn, and the prompt is written to
// the child's stdin which is then closed immediately. That made mid-turn
// steering structurally impossible, which is why every Codex run used to fall
// back to the Slack ⏳ queue while Claude runs got the message injected live.
// We no longer use that wrapper for running turns — only the `codex` binary it
// vendors — so this client is the ONLY Codex execution path.
//
// `codex app-server` is the persistent JSON-RPC protocol the real Codex app
// speaks. It keeps ONE process per thread and exposes `turn/steer`, which
// injects a user message into the turn that is currently running — exact parity
// with agent-core's AgentInputChannel on the Claude side.
//
// The protocol is experimental. Everything we depend on is narrow and asserted
// by tests against a fake server (tests/codex-app-server.test.ts): the
// `initialize`/`initialized` handshake, `thread/start`, `thread/resume`,
// `turn/start`, `turn/steer`, `turn/interrupt`, and a handful of notifications.
// Pin the codex version in the agent images and re-check these when upgrading.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Explicit binary override (also the seam tests use to point at a fake server). */
export const CODEX_APP_SERVER_BIN = "CODEX_APP_SERVER_BIN";

// ------------------------------------------------------------------ binary

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64"
};

function targetTriple(): string | null {
  const { platform, arch } = process;
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    return null;
  }
  return null;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function requireBases(): string[] {
  const bases: string[] = [];
  try {
    if (typeof __dirname === "string") bases.push(path.join(__dirname, "codex-resolve.js"));
  } catch {
    // ESM build — __dirname is not defined.
  }
  // ESM anchor: the agent images run agent-core via tsx under `"type":
  // "module"`, where __dirname does not exist and cwd is the mounted
  // /workspace. The entrypoint script (process.argv[1]) lives beside
  // node_modules (/agent/agent-entrypoint.ts in the container), so it is a
  // reliable base there — without it, binary resolution failed on every
  // containerized Codex app-server run.
  const entryScript = process.argv[1];
  if (entryScript) bases.push(path.join(path.dirname(entryScript), "codex-resolve.js"));
  bases.push(path.join(process.cwd(), "codex-resolve.js"));
  return bases;
}

/**
 * Candidate `<platformPackage>/vendor` directories reachable from one require
 * base. Deliberately does NOT go through `@openai/codex-sdk/package.json`: that
 * subpath is not listed in the SDK's `exports`, so resolving it throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The platform package has no `exports` map, so
 * it can be resolved directly; the SDK's own main entry is the fallback anchor
 * for nested/hoisted installs.
 */
function vendorRootsFrom(base: string, platformPackage: string): string[] {
  const roots: string[] = [];
  const push = (packageDir: string) => {
    const vendor = path.join(packageDir, "vendor");
    if (!roots.includes(vendor)) roots.push(vendor);
  };
  const anchors: string[] = [base];
  try {
    anchors.push(createRequire(base).resolve("@openai/codex-sdk"));
  } catch {
    // SDK not resolvable from this base — the direct lookup below may still work.
  }
  for (const anchor of anchors) {
    try {
      push(path.dirname(createRequire(anchor).resolve(`${platformPackage}/package.json`)));
    } catch {
      // Not resolvable from this anchor.
    }
    // Plain directory walk, for installs where the package exposes no resolvable
    // file at all (some CI layouts prune package.json from the module map).
    let dir = path.dirname(anchor);
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = path.join(dir, "node_modules", platformPackage);
      try {
        if (fs.statSync(candidate).isDirectory()) push(candidate);
      } catch {
        // keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return roots;
}

/**
 * Locate the `codex` executable the same way @openai/codex-sdk does: through the
 * per-platform vendor package that ships beside @openai/codex-sdk. We resolve it
 * ourselves so the app-server path does not depend on the SDK's private
 * internals (and so tests can substitute a fake server binary).
 */
export function resolveCodexBinary(env: Record<string, string | undefined> = process.env): string {
  const override = env[CODEX_APP_SERVER_BIN]?.trim();
  if (override) return override;
  const triple = targetTriple();
  if (!triple) {
    throw new Error(`Codex app-server: unsupported platform ${process.platform}/${process.arch}.`);
  }
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple];
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  for (const base of requireBases()) {
    for (const vendorRoot of vendorRootsFrom(base, platformPackage)) {
      const packageRoot = path.join(vendorRoot, triple);
      const modern = path.join(packageRoot, "bin", binaryName);
      if (isFile(modern)) return modern;
      const legacy = path.join(packageRoot, "codex", binaryName);
      if (isFile(legacy)) return legacy;
    }
  }
  throw new Error(
    `Codex app-server: unable to locate the codex binary for ${triple}. ` +
      `Ensure @openai/codex-sdk is installed with its optional platform packages, or set ${CODEX_APP_SERVER_BIN}.`
  );
}

// ------------------------------------------------------------------- client

export type CodexNotification = { method: string; params: Record<string, unknown> };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };

export class CodexAppServerError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

export type CodexAppServerSpawnOptions = {
  /** Executable to run. Defaults to the resolved codex binary. */
  command?: string;
  /** Arguments. Defaults to ["app-server"]. */
  args?: string[];
  env: Record<string, string>;
  cwd?: string;
  onStderr?: (line: string) => void;
};

export class CodexAppServerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<(notification: CodexNotification) => void>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail: string[] = [];
  private exitReason: Error | null = null;
  private closing = false;

  private constructor(child: ChildProcess, onStderr?: (line: string) => void) {
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.consume(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const text = String(chunk);
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      onStderr?.(text);
    });
    const fail = (error: Error) => {
      this.exitReason ??= error;
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(error);
      }
    };
    child.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code, signal) => {
      if (this.closing) {
        fail(new CodexAppServerError("Codex app-server was shut down."));
        return;
      }
      const tail = this.stderrTail.join("").trim().slice(-800);
      fail(
        new CodexAppServerError(
          `Codex app-server exited (code=${code ?? "null"} signal=${signal ?? "null"})${tail ? `: ${tail}` : ""}.`
        )
      );
    });
  }

  static async start(options: CodexAppServerSpawnOptions): Promise<CodexAppServerClient> {
    const command = options.command ?? resolveCodexBinary(options.env);
    // The CLI refuses to boot when CODEX_HOME points at a missing directory,
    // and agent-core always pins it to a run-scoped path that may not exist yet.
    const codexHome = options.env.CODEX_HOME?.trim();
    if (codexHome) {
      try {
        fs.mkdirSync(codexHome, { recursive: true });
      } catch {
        // Surfaced by the server's own startup error if it really matters.
      }
    }
    const child = spawn(command, options.args ?? ["app-server"], {
      env: options.env as NodeJS.ProcessEnv,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new CodexAppServerClient(child, options.onStderr);
    await client.request("initialize", {
      clientInfo: { name: "r-docs", version: "1.0.0" },
      capabilities: { experimentalApi: true }
    });
    client.notify("initialized", {});
    return client;
  }

  onNotification(handler: (notification: CodexNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private consume(chunk: string) {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>) {
    const id = message.id as number | string | undefined;
    const method = message.method as string | undefined;
    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(id as number);
      if (!pending) return;
      this.pending.delete(id as number);
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(
          new CodexAppServerError(`${pending.method} failed: ${error.message ?? "unknown error"}`, error.code)
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (id !== undefined && method) {
      // A server->client REQUEST. With approvalPolicy "never" and a
      // full-access sandbox none of these should fire, but an unanswered
      // request would hang the server forever, so always reply.
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported request: ${method}` } });
      return;
    }
    if (!method) return;
    const notification: CodexNotification = {
      method,
      params: (message.params as Record<string, unknown>) ?? {}
    };
    for (const handler of this.handlers) {
      try {
        handler(notification);
      } catch {
        // A misbehaving consumer must not tear down the transport.
      }
    }
  }

  private write(payload: Record<string, unknown>) {
    if (!this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method: string, params: Record<string, unknown>) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.exitReason) return Promise.reject(this.exitReason);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    // The server exits on stdin EOF; make sure a wedged one cannot outlive us.
    const timer = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 5_000);
    timer.unref?.();
    this.child.once("exit", () => clearTimeout(timer));
  }
}
