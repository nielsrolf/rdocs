import assert from "node:assert/strict";
import { test } from "node:test";

import { channelRunMessageSchema } from "../lib/agent-channel-runs";
import { mcpToolsFor } from "../lib/mcp/tools";
import {
  applyRunCredentialPolicy,
  describeRunCredentialPolicy,
  policyAllowsGithub,
  runCredentialPolicySchema
} from "../lib/run-credential-policy";

const resolved = {
  LITELLM_API_KEY: "sk-litellm",
  LITELLM_BASE_URL: "https://litellm.example",
  GITHUB_TOKEN: "ghp_user",
  GH_TOKEN: "ghp_user",
  HF_TOKEN: "hf_user",
  CODEX_CHATGPT_AUTH_JSON: "{}",
  DOC_SECRET: "doc"
};

test("a policy keeps only allowlisted variables, routing settings and per-run values", () => {
  const policy = runCredentialPolicySchema.parse({ allowEnv: ["LITELLM_API_KEY"], env: { RUNPOD_API_KEY: "rp_run" } });
  const { env, kept, dropped } = applyRunCredentialPolicy(resolved, policy);
  assert.deepEqual(env, {
    LITELLM_API_KEY: "sk-litellm",
    LITELLM_BASE_URL: "https://litellm.example",
    RUNPOD_API_KEY: "rp_run"
  });
  assert.deepEqual(kept, ["LITELLM_API_KEY", "LITELLM_BASE_URL", "RUNPOD_API_KEY"]);
  assert.deepEqual(dropped, ["CODEX_CHATGPT_AUTH_JSON", "DOC_SECRET", "GH_TOKEN", "GITHUB_TOKEN", "HF_TOKEN"]);
});

test("per-run values override resolved ones, and an empty policy withholds every secret", () => {
  const override = runCredentialPolicySchema.parse({ allowEnv: ["HF_TOKEN"], env: { HF_TOKEN: "hf_narrow" } });
  assert.equal(applyRunCredentialPolicy(resolved, override).env.HF_TOKEN, "hf_narrow");
  const empty = applyRunCredentialPolicy(resolved, runCredentialPolicySchema.parse({}));
  assert.deepEqual(empty.env, { LITELLM_BASE_URL: "https://litellm.example" });
});

test("GitHub access is granted only when asked for", () => {
  assert.equal(policyAllowsGithub(null), true, "no policy = unchanged behaviour");
  assert.equal(policyAllowsGithub(runCredentialPolicySchema.parse({})), false);
  assert.equal(policyAllowsGithub(runCredentialPolicySchema.parse({ allowEnv: ["GITHUB_TOKEN"] })), true);
  assert.equal(policyAllowsGithub(runCredentialPolicySchema.parse({ env: { GH_TOKEN: "ghp_single_repo" } })), true);
});

test("the channel run payload accepts credentials and rejects bad variable names", () => {
  const ok = channelRunMessageSchema.safeParse({
    message: "do it",
    credentials: { allowEnv: ["LITELLM_API_KEY"], env: { RUNPOD_API_KEY: "x" }, allowMcpServers: ["wandb"] }
  });
  assert.equal(ok.success, true);
  assert.equal(channelRunMessageSchema.safeParse({ message: "do it" }).success, true);
  assert.equal(channelRunMessageSchema.safeParse({ message: "x", credentials: { allowEnv: ["BAD NAME"] } }).success, false);
  assert.equal(channelRunMessageSchema.safeParse({ message: "x", credentials: { env: { "A=B": "1" } } }).success, false);
});

test("a restricted run's document bridge cannot schedule, change env, create workspaces or mint keys", () => {
  const names = mcpToolsFor({ scopeDocumentId: "docA", toolset: "document-only" }).map((tool) => tool.name);
  assert.ok(names.includes("read_document") && names.includes("replace_in_document"));
  for (const refused of ["schedule_task", "update_scheduled_task", "set_workspace_env", "create_workspace",
    "provision_litellm_key", "list_workspace_env", "list_documents", "create_document"]) {
    assert.equal(names.includes(refused), false, refused);
  }
  const full = mcpToolsFor({ scopeDocumentId: "docA" }).map((tool) => tool.name);
  assert.ok(full.includes("schedule_task"), "unrestricted headless runs are unchanged");
});

test("the timeline note lists names only", () => {
  const note = describeRunCredentialPolicy(["LITELLM_API_KEY", "RUNPOD_API_KEY"], []);
  assert.match(note, /LITELLM_API_KEY, RUNPOD_API_KEY/);
  assert.doesNotMatch(note, /sk-|rp_/);
});
