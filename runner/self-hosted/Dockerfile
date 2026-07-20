# Self-hosted agent worker image. Runs OUTSIDE the app's own infrastructure —
# on a document owner's own machine — polling the app's
# /api/self-hosted/jobs/* HTTP endpoints and executing jobs with agent-core
# (the same execution engine runner/Dockerfile.agent wraps for the app's own
# container runner), using the owner's own ANTHROPIC_API_KEY / GITHUB_TOKEN.
#
# There is deliberately NO app-side OS sandbox here — unlike Dockerfile.agent,
# whose whole point is confining an UNTRUSTED per-document agent run to a
# throwaway mount namespace on infrastructure the app operator controls, this
# container runs on infrastructure the document OWNER already controls, with
# THEIR credentials. Its job is convenience packaging (agent-core + a git
# client + the poll loop), not sandboxing.
#
# Build context is the gdocs-ai repo ROOT (so agent-core/ can be COPYed):
#   docker build -f runner/self-hosted/Dockerfile -t gdocs-self-hosted-worker:local .
#
# Run:
#   docker run --rm \
#     -e APP_URL=https://docs.nielsrolf.com \
#     -e SELF_HOSTED_TOKEN=gdai_... \
#     -e ANTHROPIC_API_KEY=sk-ant-... \
#     gdocs-self-hosted-worker:local
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip git ca-certificates ripgrep curl \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI — reads GH_TOKEN from the env if the user sets one; also useful
# for a pre-existing WORKSPACE_REPO_PATH checkout's git remote operations.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

ENV HOME=/root

WORKDIR /agent
COPY runner/self-hosted/package.json /agent/package.json
RUN npm install --omit=dev --no-audit --no-fund

# agent-core is the framework-free execution engine shared with the app's own
# container runner (runner/agent-entrypoint.ts) — this image reuses it as-is.
COPY agent-core /agent/agent-core
COPY runner/self-hosted/worker.ts /agent/worker.ts

# Required at runtime: APP_URL, SELF_HOSTED_TOKEN, and whatever credential env
# vars the agent needs (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN;
# GITHUB_TOKEN for gh/git). Repo-backed documents are cloned per job from the
# repo coordinates in the job payload using THIS container's git credentials.
# Optional: WORKSPACE_REPO_PATH (a bind-mounted checkout used instead of
# cloning — e.g. for private remotes this box can't reach).
ENTRYPOINT ["/agent/node_modules/.bin/tsx", "/agent/worker.ts"]
