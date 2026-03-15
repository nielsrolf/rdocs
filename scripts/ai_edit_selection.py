import asyncio
import json
import os
import pathlib
import sys

WORKSPACE_ROOT = pathlib.Path(__file__).resolve().parent.parent
PYTHON_HOME = WORKSPACE_ROOT / ".python-home"
CACHE_HOME = WORKSPACE_ROOT / ".cache"
PYTHON_HOME.mkdir(parents=True, exist_ok=True)
CACHE_HOME.mkdir(parents=True, exist_ok=True)
os.environ["HOME"] = str(PYTHON_HOME)
os.environ["XDG_CACHE_HOME"] = str(CACHE_HOME)

from localrouter import ChatMessage, ImageBlock, MessageRole, TextBlock, get_response


def build_user_prompt(payload: dict) -> str:
    return f"""You are editing a document selection.

Document title:
{payload['documentTitle']}

Full document:
{payload['documentText']}

Selected text:
{payload['selectedText']}

Selected text with surrounding context:
{payload.get('selectedContext') or 'n/a'}

Instruction:
{payload['instruction']}

Return only the new text that should replace the selected text.
Do not include quotes, markdown fences, commentary, or explanations.
"""


def build_document_blocks(payload: dict) -> list:
    content_blocks = [TextBlock(text=build_user_prompt(payload))]

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
    model = os.getenv("AI_COMMENT_MODEL", "gpt-5.4")

    response = await asyncio.wait_for(
        get_response(
            model=model,
            messages=[
                ChatMessage(
                    role=MessageRole.system,
                    content=[
                        TextBlock(
                            text="Rewrite the selected text according to the instruction. Return only replacement text."
                        )
                    ],
                ),
                ChatMessage(
                    role=MessageRole.user,
                    content=build_document_blocks(payload),
                ),
            ],
            max_tokens=600,
        ),
        timeout=70,
    )

    text_parts = []
    for block in response.content:
        if isinstance(block, TextBlock):
            text_parts.append(block.text)

    replacement = "\n".join(part.strip() for part in text_parts if part.strip()).strip()
    print(json.dumps({"replacementText": replacement, "model": model}))


if __name__ == "__main__":
    asyncio.run(main())
