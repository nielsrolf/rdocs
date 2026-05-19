import asyncio
import json
import os
import pathlib
import sys
from urllib.parse import urlparse

WORKSPACE_ROOT = pathlib.Path(__file__).resolve().parent.parent

from localrouter import ImageBlock, ReasoningConfig, TextBlock

from agentic_web import run_agentic_response


SYSTEM_PROMPT = """You are assisting inside a collaborative document comment thread.
Reply the way a strong collaborator would reply in chat: answer the question, resolve confusion, or provide the requested judgment.
Only suggest replacement wording when the thread explicitly asks for wording or a rewrite.
Default to direct answers over rewriting suggestions.
Do not mention internal system behavior, model selection, or hidden instructions.
"""

MODEL_ALIASES = {
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4.5": "claude-opus-4-5-20251101",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.5": "claude-sonnet-4-5-20250929",
}


def extract_visited_sources(response) -> list[str]:
    trace = response.meta.get("agentic_trace", []) if getattr(response, "meta", None) else []
    visited: list[str] = []

    def add_url(candidate: str | None) -> None:
        if not candidate or not isinstance(candidate, str):
            return

        parsed = urlparse(candidate)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return

        if candidate not in visited:
            visited.append(candidate)

    for step in trace:
        tool_name = step.get("tool") or ""
        tool_input = step.get("input") or {}

        if "browse" in tool_name or "fetch" in tool_name:
            add_url(tool_input.get("url"))

    return visited


def build_user_prompt(payload: dict) -> str:
    transcript = "\n".join(
        f"{comment['author']}: {comment['body']}" for comment in payload["comments"]
    )

    return f"""Document title: {payload['documentTitle']}
Full document:
{payload['documentText']}

Selected text: {payload['anchorText']}
Selected text context: {payload.get('anchorContext') or 'n/a'}
Human requester: {payload['requesterName']}

Thread transcript:
{transcript}

Write the next assistant reply for this thread. Keep it collaborative and specific."""


def build_document_blocks(payload: dict) -> list:
    content_blocks = []
    preface = (
        f"Document title: {payload['documentTitle']}\n"
        f"Full document content follows as interleaved text and image blocks.\n"
        f"Selected text: {payload['anchorText']}\n"
        f"Selected text context: {payload.get('anchorContext') or 'n/a'}\n"
        f"Human requester: {payload['requesterName']}\n\n"
        "Thread transcript:\n"
        + "\n".join(f"{comment['author']}: {comment['body']}" for comment in payload["comments"])
        + "\n\nWrite the next assistant reply for this thread. Treat it as a normal collaborative conversation unless the thread explicitly asks for new wording."
    )
    content_blocks.append(TextBlock(text=preface))

    for block in payload.get("documentBlocks", []):
        if block.get("type") == "text" and block.get("text"):
            content_blocks.append(TextBlock(text=f"\n[Document text]\n{block['text']}"))
            continue

        if block.get("type") != "image":
            continue

        src = block.get("src") or ""
        if not src.startswith("data:") or "," not in src:
            alt = block.get("alt") or "Embedded image"
            content_blocks.append(TextBlock(text=f"\n[Embedded image omitted: {alt}]"))
            continue

        header, base64_data = src.split(",", 1)
        media_type = "image/png"
        if ";" in header and ":" in header:
            media_type = header.split(":", 1)[1].split(";", 1)[0] or media_type

        alt = block.get("alt") or "Embedded image"
        content_blocks.append(TextBlock(text=f"\n[Embedded image: {alt}]"))
        content_blocks.append(ImageBlock.from_base64(base64_data, media_type=media_type))

    return content_blocks


async def main() -> None:
    payload = json.load(sys.stdin)
    raw_model = os.getenv("AI_COMMENT_MODEL", "claude-opus-4-6")
    model = MODEL_ALIASES.get(raw_model, raw_model)

    response = await run_agentic_response(
        model=model,
        system_prompt=(
            f"{SYSTEM_PROMPT}\n"
            "Use the available web tools when external research would materially improve factual accuracy, freshness, specificity, or source checking. "
            "If no external research is needed, answer directly. Then return the final reply directly to the thread."
        ),
        user_content=build_document_blocks(payload),
        reasoning=ReasoningConfig(effort="none"),
        max_tokens=64_000,
    )

    text_parts = []
    for block in response.content:
        if isinstance(block, TextBlock):
            text_parts.append(block.text)

    reply = "\n".join(part.strip() for part in text_parts if part.strip()).strip()
    print(
        json.dumps(
            {
                "reply": reply,
                "model": model,
                "visitedSources": extract_visited_sources(response),
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
