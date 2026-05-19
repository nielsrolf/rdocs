import asyncio
import json
import os
import sys
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    query,
)

CLAUDE_AGENT_TOOLS = [
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Grep",
    "Glob",
    "LS",
    "Bash",
    "WebSearch",
    "WebFetch",
]


def compact(value: Any, limit: int = 1200) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except TypeError:
        text = str(value)
    text = text.strip()
    return text if len(text) <= limit else f"{text[:limit].rstrip()}..."


async def main() -> None:
    payload = json.load(sys.stdin)
    cwd = payload["workspace"]
    commit_sha = payload["commitSha"]
    model = os.getenv("CLAUDE_AGENT_MODEL", "sonnet")

    prompt = f"""A git merge is currently in progress in this repository.

The commit being merged is {commit_sha}.

Resolve all merge conflicts in the working tree. Preserve both the base branch intent and the incoming AI agent changes whenever they are compatible. If a real semantic conflict exists, make the smallest coherent implementation that keeps the repository buildable.

Do not commit. After editing, run `git status --porcelain` and report whether any unmerged paths remain.

Return only JSON:
{{"summary":"what you resolved","unresolved":false}}
"""

    options = ClaudeAgentOptions(
        cwd=cwd,
        system_prompt=(
            "You are resolving git merge conflicts for a collaborative document app. "
            "Edit files directly, remove conflict markers, and keep the result coherent. "
            "Do not run background processes and do not commit."
        ),
        permission_mode="bypassPermissions",
        allowed_tools=CLAUDE_AGENT_TOOLS,
        max_turns=int(os.getenv("CLAUDE_MERGE_MAX_TURNS", "8")),
        model=model,
    )

    text_parts: list[str] = []
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    text_parts.append(block.text)
                elif isinstance(block, ToolUseBlock):
                    print(
                        json.dumps(
                            {
                                "type": "progress",
                                "message": f"{block.name}: {compact(block.input)}",
                            }
                        ),
                        file=sys.stderr,
                        flush=True,
                    )
        elif isinstance(message, ResultMessage):
            if message.errors:
                print("\n".join(message.errors), file=sys.stderr, flush=True)

    print(json.dumps({"ok": True, "output": "\n".join(text_parts).strip()}))


if __name__ == "__main__":
    asyncio.run(main())
