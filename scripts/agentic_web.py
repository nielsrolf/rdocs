import asyncio
import html
import json
import os
import pathlib
import re
import socket
import subprocess
import xml.etree.ElementTree as ET
from contextlib import AsyncExitStack
from html.parser import HTMLParser
from ipaddress import ip_address
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote_plus, unquote, urlparse
from urllib.request import Request, urlopen

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from localrouter import (
    ChatMessage,
    MessageRole,
    ReasoningConfig,
    TextBlock,
    ToolDefinition,
    ToolResultBlock,
    ToolUseBlock,
    get_response,
)


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_TOOL_TIMEOUT_SECONDS = 15
DEFAULT_MODEL_TIMEOUT_SECONDS = 70
DEFAULT_MAX_TOOL_ROUNDS = 6
MAX_FETCH_BYTES = 2_000_000
WORKSPACE_ROOT = pathlib.Path(__file__).resolve().parent.parent

MCP_SERVER_SPECS = {
    "brave_search": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "required_env": ["BRAVE_API_KEY"],
        "extra_env": {
            "npm_config_loglevel": "error",
            "npm_config_fund": "false",
            "npm_config_audit": "false",
            "npm_config_update_notifier": "false",
        },
    },
    "fetch": {
        "command": "uvx",
        "args": ["-q", "--no-progress", "mcp-server-fetch"],
        "required_env": [],
        "extra_env": {
            "UV_NO_PROGRESS": "1",
        },
        "prewarm": ["uvx", "-q", "--no-progress", "mcp-server-fetch", "--help"],
    },
}


class HtmlTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self._in_title = False
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
        if self._skip_depth == 0 and tag in {"p", "div", "section", "article", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth > 0:
            self._skip_depth -= 1
        if self._skip_depth == 0 and tag in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not data.strip():
            return
        if self._in_title:
            self.title += data.strip()
            return
        if self._skip_depth == 0:
            self._parts.append(data)

    def get_text(self) -> str:
        combined = html.unescape("".join(self._parts))
        combined = re.sub(r"(?:\s*\n\s*)+", "\n", combined)
        combined = re.sub(r"[^\S\n]+", " ", combined)
        return combined.strip()


def _normalize_url(url: str) -> str:
    normalized = url.strip()
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only public http and https URLs are allowed.")
    if not parsed.netloc:
        raise ValueError("URL must include a hostname.")
    return normalized


def _is_public_hostname(hostname: str) -> bool:
    lower = hostname.lower().strip("[]")
    if lower in {"localhost", "localhost.localdomain"}:
        return False

    try:
        ip = ip_address(lower)
        return not (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        )
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return True

    for info in infos:
        address = info[4][0]
        try:
            ip = ip_address(address)
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return False

    return True


def _make_request(url: str) -> Request:
    return Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )


def _decode_bytes(raw: bytes, content_type: str | None) -> str:
    charset_match = re.search(r"charset=([^;]+)", content_type or "", flags=re.IGNORECASE)
    encoding = charset_match.group(1).strip() if charset_match else "utf-8"
    try:
        return raw.decode(encoding, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def _fetch_url(url: str) -> tuple[str | None, str]:
    normalized = _normalize_url(url)
    parsed = urlparse(normalized)
    if not _is_public_hostname(parsed.hostname or ""):
        raise ValueError("Refusing to fetch local or private-network addresses.")

    with urlopen(_make_request(normalized), timeout=DEFAULT_TOOL_TIMEOUT_SECONDS) as response:
        content_type = response.headers.get("Content-Type")
        raw = response.read(MAX_FETCH_BYTES + 1)
        if len(raw) > MAX_FETCH_BYTES:
            raw = raw[:MAX_FETCH_BYTES]
        return content_type, _decode_bytes(raw, content_type)


def _clean_search_result_url(url: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    redirected = query.get("uddg")
    if redirected:
        return unquote(redirected[0])
    if url.startswith("//"):
        return f"https:{url}"
    return url


def _extract_domain_preferences(query: str, preferred_domains: list[str] | None) -> tuple[str, list[str]]:
    domains = [domain.lower().strip() for domain in (preferred_domains or []) if domain.strip()]
    extracted = re.findall(r"site:([^\s]+)", query, flags=re.IGNORECASE)
    for domain in extracted:
        clean_domain = domain.lower().strip()
        if clean_domain and clean_domain not in domains:
            domains.append(clean_domain)

    cleaned_query = re.sub(r"\bsite:[^\s]+\b", " ", query, flags=re.IGNORECASE)
    cleaned_query = re.sub(r"\s+", " ", cleaned_query).strip()
    return cleaned_query or query.strip(), domains


def _domain_matches(url: str, preferred_domains: list[str]) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(host == domain or host.endswith(f".{domain}") for domain in preferred_domains)


def web_search(query: str, max_results: int = 5, preferred_domains: list[str] | None = None) -> str:
    cleaned_query = query.strip()
    if not cleaned_query:
        raise ValueError("Search query cannot be empty.")

    limit = max(1, min(int(max_results or 5), 8))
    search_query, normalized_domains = _extract_domain_preferences(cleaned_query, preferred_domains)
    search_url = f"https://www.bing.com/search?format=rss&q={quote_plus(search_query)}"
    _, body = _fetch_url(search_url)

    results: list[dict[str, str]] = []
    try:
        root = ET.fromstring(body)
        for item in root.findall("./channel/item"):
            title = (item.findtext("title") or "").strip()
            url = (item.findtext("link") or "").strip()
            snippet = (item.findtext("description") or "").strip()
            if not title or not url:
                continue
            results.append({"title": title, "url": url, "snippet": snippet})
    except ET.ParseError:
        pass

    if normalized_domains and results:
        preferred = [result for result in results if _domain_matches(result["url"], normalized_domains)]
        non_preferred = [result for result in results if not _domain_matches(result["url"], normalized_domains)]
        results = preferred + non_preferred

    results = results[:limit]

    note = None
    if not results:
        note = "No results were parsed from Bing RSS output."

    return json.dumps(
        {
            "query": cleaned_query,
            **({"preferred_domains": normalized_domains} if normalized_domains else {}),
            "results": results,
            **({"note": note} if note else {}),
        },
        ensure_ascii=False,
    )


def browse_page(url: str, max_chars: int = 12000) -> str:
    limit = max(1000, min(int(max_chars or 12000), 20000))
    content_type, body = _fetch_url(url)
    lowered_type = (content_type or "").lower()

    if "html" in lowered_type or "xml" in lowered_type or not lowered_type:
        parser = HtmlTextExtractor()
        parser.feed(body)
        title = parser.title.strip() or url
        text = parser.get_text()
    else:
        title = url
        text = body.strip()

    text = text[:limit].strip()
    return json.dumps(
        {
            "url": url,
            "content_type": content_type,
            "title": title,
            "content": text,
            "truncated": len(text) >= limit,
        },
        ensure_ascii=False,
    )


class MCPToolRegistry:
    def __init__(self) -> None:
        self._stack = AsyncExitStack()
        self._sessions: dict[str, ClientSession] = {}
        self._tool_map: dict[str, tuple[str, str]] = {}
        self.tool_definitions: list[ToolDefinition] = []
        self.server_notes: list[str] = []

    async def __aenter__(self) -> "MCPToolRegistry":
        for server_name, spec in MCP_SERVER_SPECS.items():
            missing = [key for key in spec["required_env"] if not os.environ.get(key)]
            if missing:
                self.server_notes.append(
                    f"{server_name} unavailable: missing environment variables {', '.join(missing)}."
                )
                continue

            env = os.environ.copy()
            env.update(spec.get("extra_env", {}))
            prewarm_command = spec.get("prewarm")
            if prewarm_command:
                try:
                    subprocess.run(
                        prewarm_command,
                        cwd=WORKSPACE_ROOT,
                        env=env,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=True,
                    )
                except Exception as exc:
                    self.server_notes.append(f"{server_name} prewarm warning: {exc}")
            params = StdioServerParameters(
                command=spec["command"],
                args=list(spec["args"]),
                env=env,
                cwd=str(WORKSPACE_ROOT),
            )

            try:
                read, write = await self._stack.enter_async_context(stdio_client(params))
                session = await self._stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                self._sessions[server_name] = session
                tools = await session.list_tools()
            except Exception as exc:
                self.server_notes.append(f"{server_name} unavailable: {exc}")
                continue

            for tool in tools.tools:
                qualified_name = f"{server_name}__{tool.name}"
                self._tool_map[qualified_name] = (server_name, tool.name)
                self.tool_definitions.append(
                    ToolDefinition(
                        name=qualified_name,
                        description=f"[{server_name}] {tool.description or tool.name}",
                        input_schema=tool.inputSchema,
                    )
                )

        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self._stack.aclose()

    async def call_tool(self, qualified_name: str, payload: dict[str, Any]) -> str:
        server_name, tool_name = self._tool_map[qualified_name]
        session = self._sessions[server_name]
        result = await session.call_tool(tool_name, payload)

        structured = getattr(result, "structuredContent", None)
        if structured is not None:
            return json.dumps(structured, ensure_ascii=False)

        parts = []
        for item in getattr(result, "content", []) or []:
            text = getattr(item, "text", None)
            if text:
                parts.append(text)

        output = "\n".join(parts).strip()
        if getattr(result, "isError", False):
            return json.dumps({"error": output or "MCP tool call failed."}, ensure_ascii=False)

        return output or json.dumps({"ok": True}, ensure_ascii=False)


async def _run_tool(tool_registry: MCPToolRegistry, tool_call: ToolUseBlock) -> str:
    payload = tool_call.input or {}

    try:
        return await asyncio.wait_for(
            tool_registry.call_tool(tool_call.name, payload),
            timeout=DEFAULT_TOOL_TIMEOUT_SECONDS + 10,
        )
    except Exception as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)


def _infer_result_count(tool_name: str, output: str) -> int | None:
    try:
        parsed_output = json.loads(output)
        if isinstance(parsed_output, dict) and isinstance(parsed_output.get("results"), list):
            return len(parsed_output["results"])
    except json.JSONDecodeError:
        pass

    if "search" in tool_name:
        title_hits = len(re.findall(r"(?m)^Title:\s", output))
        if title_hits > 0:
            return title_hits

    return None


def _blocks_to_text(content: list[Any]) -> str:
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts)


def _user_explicitly_requests_web_tools(user_content: list[Any]) -> bool:
    text = _blocks_to_text(user_content).lower()
    phrases = (
        "use your web search",
        "use web search",
        "search the web",
        "search the internet",
        "look it up",
        "browse the web",
        "use the browser",
        "verify online",
    )
    return any(phrase in text for phrase in phrases)


async def run_agentic_response(
    *,
    model: str,
    system_prompt: str,
    user_content: list[Any],
    max_tokens: int,
    reasoning: ReasoningConfig | None = None,
    max_tool_rounds: int = DEFAULT_MAX_TOOL_ROUNDS,
) -> ChatMessage:
    explicit_tool_request = _user_explicitly_requests_web_tools(user_content)

    async with MCPToolRegistry() as tool_registry:
        tool_names = [tool.name for tool in tool_registry.tool_definitions]
        effective_system_prompt = (
            f"{system_prompt}\n"
            "Use the available external tools whenever outside information would materially improve accuracy, freshness, specificity, or source grounding. "
            "Do not guess current facts when a search or fetch would resolve them. "
            "When possible, do one targeted search, then fetch a promising authoritative page to verify key facts. Avoid redundant searches that just restate the same query. "
            "If fetch fails to simplify a page, retry with raw=true and extract the needed fact from the raw content. "
            "If the user explicitly asks you to use web search or browse, you must do so before answering.\n"
            f"Available MCP tools: {', '.join(tool_names) if tool_names else 'none'}.\n"
            f"{' '.join(tool_registry.server_notes)}"
        )

        messages = [
            ChatMessage(role=MessageRole.system, content=[TextBlock(text=effective_system_prompt)]),
            ChatMessage(role=MessageRole.user, content=user_content),
        ]
        agentic_trace: list[dict[str, Any]] = []
        search_used = False

        for _ in range(max_tool_rounds):
            response = await asyncio.wait_for(
                get_response(
                    model=model,
                    messages=messages,
                    tools=tool_registry.tool_definitions or None,
                    reasoning=reasoning,
                    max_tokens=max_tokens,
                ),
                timeout=DEFAULT_MODEL_TIMEOUT_SECONDS,
            )
            messages.append(response)

            tool_calls = [block for block in response.content if isinstance(block, ToolUseBlock)]
            if not tool_calls:
                if explicit_tool_request and not search_used and tool_registry.tool_definitions:
                    messages.append(
                        ChatMessage(
                            role=MessageRole.user,
                            content=[
                                TextBlock(
                                    text=(
                                        "You have not used the external tools yet, but the user explicitly asked you to. "
                                        "Use the available MCP search or fetch tools now before answering."
                                    )
                                )
                            ],
                        )
                    )
                    continue

                response.meta["agentic_trace"] = agentic_trace
                response.meta["explicit_tool_request"] = explicit_tool_request
                response.meta["search_used"] = search_used
                response.meta["mcp_server_notes"] = tool_registry.server_notes
                return response

            tool_results = []
            for tool_call in tool_calls:
                output = await _run_tool(tool_registry, tool_call)
                result_count = _infer_result_count(tool_call.name, output)
                agentic_trace.append(
                    {
                        "tool": tool_call.name,
                        "input": tool_call.input or {},
                        "result_count": result_count,
                        "output_preview": output[:400],
                    }
                )
                if "search" in tool_call.name:
                    search_used = True
                tool_results.append(
                    ToolResultBlock(
                        tool_use_id=tool_call.id,
                        content=[TextBlock(text=output)],
                    )
                )

            messages.append(ChatMessage(role=MessageRole.user, content=tool_results))

        messages.append(
            ChatMessage(
                role=MessageRole.user,
                content=[
                    TextBlock(
                        text="Tool budget reached. Please give the best final answer using the information already gathered, without calling more tools."
                    )
                ],
            )
        )

        final_response = await asyncio.wait_for(
            get_response(
                model=model,
                messages=messages,
                reasoning=reasoning,
                max_tokens=max_tokens,
            ),
            timeout=DEFAULT_MODEL_TIMEOUT_SECONDS,
        )
        final_response.meta["agentic_trace"] = agentic_trace
        final_response.meta["explicit_tool_request"] = explicit_tool_request
        final_response.meta["search_used"] = search_used
        final_response.meta["tool_budget_exhausted"] = True
        final_response.meta["mcp_server_notes"] = tool_registry.server_notes
        return final_response
