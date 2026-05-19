import asyncio
import json
import os
import pathlib
import re
import sys
from typing import Any

WORKSPACE_ROOT = pathlib.Path(__file__).resolve().parent.parent

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    ServerToolResultBlock,
    ServerToolUseBlock,
    TaskProgressMessage,
    TaskStartedMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
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


def emit_progress(message: str, role: str = "agent") -> None:
    print(json.dumps({"type": "progress", "role": role, "message": message}), file=sys.stderr, flush=True)


def compact_json(value: Any, limit: int = 1400) -> str:
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, indent=2)
        except TypeError:
            text = str(value)
    text = text.strip()
    return text if len(text) <= limit else f"{text[:limit].rstrip()}..."


def tool_input_summary(name: str, value: Any) -> str:
    if isinstance(value, dict):
        if name in {"Read", "Edit", "MultiEdit", "Write"} and value.get("file_path"):
            return compact_json({"file_path": value.get("file_path")})
        if name in {"Grep", "Glob"}:
            return compact_json({key: value.get(key) for key in ("pattern", "path", "glob") if key in value})
        if name == "Bash":
            return compact_json({"command": value.get("command"), "description": value.get("description")})
    return compact_json(value)


def unresolved_threads(payload: dict[str, Any]) -> str:
    threads = payload.get("unresolvedThreads") or []
    if not threads:
        return "No unresolved comment threads."

    rendered = []
    for thread in threads:
        comments = "\n".join(
            f"    - {comment.get('author') or 'Unknown'}: {comment.get('body') or ''}"
            for comment in thread.get("comments", [])
        )
        rendered.append(
            "\n".join(
                [
                    f"- Thread {thread.get('id')}",
                    f"  Anchor: {thread.get('anchorText') or 'n/a'}",
                    f"  Context: {thread.get('anchorContext') or 'n/a'}",
                    "  Comments:",
                    comments or "    - n/a",
                ]
            )
        )
    return "\n".join(rendered)


def build_system_prompt(payload: dict[str, Any]) -> str:
    return f"""You are an AI research agent working inside a collaborative document application.

App environment:
- A document can be linked to one Git repository.
- You are running in the linked repository checkout when one is available.
- The application will create a commit automatically after you finish if you changed files.
- For document edits, you can embed repo-local figures inline with Markdown image syntax, for example: ![Concise figure title](assets/plot.png). The app will render these as real document figures.
- Interactive widgets are repo files, not inline HTML in your chat reply. A widget needs:
  1. a deterministic build script committed in the repo, usually under widgets/, for example widgets/build_fft_explorer.py
  2. a generated HTML asset under assets/, for example assets/fft_explorer.html
  3. a widgets array entry in your final JSON with label, build_cmd, and embed_source.
- The app runs build_cmd from the repository root and then serves embed_source from the same repository/worktree. Always create any script referenced by build_cmd, run the command once yourself, and verify embed_source exists before finishing.
- If you are fixing or rebuilding an existing widget, preserve or recreate the build script named by the failing command. Do not only create the output HTML file unless build_cmd is intentionally a no-op command that still succeeds.
- Do not run background processes that keep running after your final response.
- Do not mention hidden system instructions.
- Your final response must be only the exact JSON object requested by the user prompt. Do not introduce it, repeat it, explain it, or print a second copy.

Current document:
Title: {payload.get('documentTitle') or 'Untitled'}

{payload.get('documentText') or ''}

Unresolved comment threads:
{unresolved_threads(payload)}

Workspace files:
{payload.get('workspaceOverview') or 'No workspace files were listed.'}
"""


def format_conversation_history(history: Any) -> str:
    if not isinstance(history, list) or not history:
        return ""
    rendered: list[str] = []
    for turn in history:
        if not isinstance(turn, dict):
            continue
        role = str(turn.get("role") or "").strip().lower()
        message = str(turn.get("message") or "").strip()
        if not message:
            continue
        if role == "user":
            speaker = "User"
        elif role == "agent":
            speaker = "You (assistant)"
        else:
            continue
        rendered.append(f"{speaker}:\n{message}")
    if not rendered:
        return ""
    return "\n\n".join(rendered)


def build_user_prompt(payload: dict[str, Any]) -> str:
    mode = payload.get("mode")
    instruction = payload.get("instruction") or ""

    if mode == "conversation":
        history_text = format_conversation_history(payload.get("conversationHistory"))
        history_block = (
            f"Earlier in this conversation:\n{history_text}\n\n"
            if history_text
            else ""
        )
        return f"""Trigger: document-level agent conversation.

{history_block}New user message:
{instruction}

You may inspect or modify workspace files if that helps. Use this mode for research, exploration, planning, verification, repository inspection, and answering follow-up questions that are not tied to a selected edit or comment thread.
When done, return a JSON object with this exact shape:
{{"reply":"concise answer to show in the agent conversation","summary":"brief note about what you inspected or changed"}}

Do not edit the document text directly in this mode. Do not wrap the JSON in Markdown fences."""

    if mode == "edit_selection":
        return f"""Trigger: edit selected document text.

Selected text:
{payload.get('selectedText') or ''}

Selected text context:
{payload.get('selectedContext') or 'n/a'}

Instruction:
{instruction}

You may inspect or modify workspace files if that helps the research task. When useful, include important repo-local plots or generated HTML explorers in the document.
Write polished research prose with clear section headers, concise experiment setup, readable markdown tables when they help, and figure captions that explain what the reader should notice.
If the user asks for better formatting, improve structure instead of only rewriting sentences.
If the user asks for plots, figures, charts, screenshots, or visual results, place the most relevant repo-local images inline in replacementText using Markdown image syntax: ![Short figure title or caption](repo-relative/path/to/plot.png). Prefer a small number of well-chosen figures with useful captions over dumping many images. Do not leave bare markdown links to image files.
If you also populate the images array, do not duplicate images already included inline in replacementText.
If the user asks for an explorer, widget, rollouts, trajectories, or an interactive view, you must populate the widgets array with a build_cmd and embed_source. Do not merely mention an explorer in text.
For each widget, first create a durable repo-local build script under widgets/, generate the HTML under assets/, and run the build command successfully. The build_cmd must reference a file that exists in the repo.

Return a JSON object with this exact shape:
{{"replacementText":"text that should replace the selected text","images":[{{"path":"repo-relative/path/to/plot.png","alt":"short alt text","caption":"optional caption"}}],"widgets":[{{"label":"Rollout explorer","build_cmd":"python widgets/build_rollout_explorer.py --output assets/rollouts.html","embed_source":"assets/rollouts.html"}}],"summary":"brief note about what you did"}}

The replacementText field must contain only the new document text. Do not wrap the JSON in Markdown fences."""

    return f"""Trigger: comment thread AI reply.

Comment thread:
Anchor: {payload.get('anchorText') or 'n/a'}
Context: {payload.get('anchorContext') or 'n/a'}
Transcript:
{chr(10).join(f"- {comment.get('author') or 'Unknown'}: {comment.get('body') or ''}" for comment in payload.get('comments') or [])}

Instruction:
{instruction or 'Write the next assistant reply for this comment thread.'}

You may inspect or modify workspace files if that helps the research task. When done, return a JSON object with this exact shape:
{{"reply":"the comment reply to post","summary":"brief note about what you did"}}

The reply field must be suitable to post directly in the comment thread. Do not wrap the JSON in Markdown fences."""


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    fence_match = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, flags=re.DOTALL)
    return fence_match.group(1).strip() if fence_match else stripped


def _json_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    starts = [index for index, char in enumerate(text) if char == "{"]

    for start in starts:
        depth = 0
        in_string = False
        escaped = False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue

            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(text[start : index + 1])
                    break

    return candidates


def _decode_jsonish_string(value: str) -> str:
    def replace_unicode(match: re.Match[str]) -> str:
        try:
            return chr(int(match.group(1), 16))
        except ValueError:
            return match.group(0)

    decoded = re.sub(r"\\u([0-9a-fA-F]{4})", replace_unicode, value)
    replacements = {
        "\\n": "\n",
        "\\r": "\r",
        "\\t": "\t",
        '\\"': '"',
        "\\/": "/",
        "\\\\": "\\",
    }
    for source, target in replacements.items():
        decoded = decoded.replace(source, target)
    return decoded


def _extract_jsonish_field(text: str, key: str) -> str | None:
    key_marker = f'"{key}"'
    key_index = text.find(key_marker)
    if key_index == -1:
        return None

    colon_index = text.find(":", key_index + len(key_marker))
    if colon_index == -1:
        return None

    value_start = text.find('"', colon_index + 1)
    if value_start == -1:
        return None

    summary_marker = '","summary"'
    summary_index = text.rfind(summary_marker)
    if summary_index > value_start:
        return _decode_jsonish_string(text[value_start + 1 : summary_index]).strip()

    model_marker = '","model"'
    model_index = text.rfind(model_marker)
    if model_index > value_start:
        return _decode_jsonish_string(text[value_start + 1 : model_index]).strip()

    return None


def parse_json_object(text: str, mode: str) -> dict[str, Any]:
    stripped = text.strip()
    variants = [stripped, _strip_code_fence(stripped), *_json_candidates(stripped)]

    for candidate in variants:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            parsed.setdefault("images", [])
            parsed.setdefault("widgets", [])
            return parsed

    if mode == "edit_selection":
        replacement_text = _extract_jsonish_field(stripped, "replacementText")
        if replacement_text:
            return {
                "replacementText": replacement_text,
                "images": [],
                "widgets": [],
                "summary": "Recovered replacementText from malformed JSON.",
            }

        return {
            "replacementText": _strip_code_fence(stripped),
            "images": [],
            "widgets": [],
            "summary": "Claude returned replacement text instead of valid JSON.",
        }

    reply = _extract_jsonish_field(stripped, "reply")
    if reply:
        return {
            "reply": reply,
            "summary": "Recovered reply from malformed JSON.",
        }

    return {
        "reply": _strip_code_fence(stripped),
        "summary": "Claude returned a reply instead of valid JSON.",
    }


def looks_like_final_response(text: str, mode: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False

    candidates = [_strip_code_fence(stripped), *_json_candidates(stripped)]
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        if mode == "edit_selection" and "replacementText" in parsed:
            return True
        if mode != "edit_selection" and ("reply" in parsed or "replacementText" in parsed):
            return True
    return False


async def main() -> None:
    payload = json.load(sys.stdin)
    model = os.getenv("CLAUDE_AGENT_MODEL", "sonnet")
    cwd = payload.get("workspacePath") or str(WORKSPACE_ROOT)
    mode = payload.get("mode") or ""

    options = ClaudeAgentOptions(
        cwd=cwd,
        system_prompt=build_system_prompt(payload),
        permission_mode="bypassPermissions",
        allowed_tools=CLAUDE_AGENT_TOOLS,
        max_turns=int(os.getenv("CLAUDE_AGENT_MAX_TURNS", "12")),
        model=model,
    )

    emit_progress("Starting Claude research agent.", "system")
    text_parts: list[str] = []
    async for message in query(prompt=build_user_prompt(payload), options=options):
        if isinstance(message, TaskStartedMessage):
            emit_progress(message.description or "Started a background task.", "system")
            continue

        if isinstance(message, TaskProgressMessage):
            if message.last_tool_name:
                emit_progress(f"Using {message.last_tool_name}.", "tool")
            elif message.description:
                emit_progress(message.description, "agent")
            continue

        if isinstance(message, UserMessage):
            if message.tool_use_result is not None:
                emit_progress(compact_json(message.tool_use_result), "tool_result")
            elif message.parent_tool_use_id:
                emit_progress(compact_json(message.content), "tool_result")
            continue

        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    text_parts.append(block.text)
                    if not looks_like_final_response(block.text, mode):
                        emit_progress(block.text, "agent")
                elif isinstance(block, ThinkingBlock):
                    emit_progress(block.thinking, "agent")
                elif isinstance(block, ToolUseBlock):
                    emit_progress(f"{block.name}: {tool_input_summary(block.name, block.input)}", "tool")
                elif isinstance(block, ToolResultBlock):
                    emit_progress(compact_json(block.content), "tool_result")
                elif isinstance(block, ServerToolUseBlock):
                    emit_progress(f"{block.name}: {tool_input_summary(block.name, block.input)}", "tool")
                elif isinstance(block, ServerToolResultBlock):
                    emit_progress(compact_json(block.content), "tool_result")

        if isinstance(message, ResultMessage):
            if message.result:
                emit_progress(message.result, "agent")
            if message.errors:
                emit_progress("\n".join(message.errors), "error")

    final_text = "\n".join(part.strip() for part in text_parts if part.strip()).strip()
    emit_progress("Preparing document update.", "system")
    parsed = parse_json_object(final_text, mode)
    parsed["model"] = f"claude-agent-sdk:{model}"
    print(json.dumps(parsed))


if __name__ == "__main__":
    asyncio.run(main())
