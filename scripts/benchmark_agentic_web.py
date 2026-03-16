import asyncio
import json
import os
import pathlib
from dataclasses import dataclass

WORKSPACE_ROOT = pathlib.Path(__file__).resolve().parent.parent
PYTHON_HOME = WORKSPACE_ROOT / ".python-home"
CACHE_HOME = WORKSPACE_ROOT / ".cache"
PYTHON_HOME.mkdir(parents=True, exist_ok=True)
CACHE_HOME.mkdir(parents=True, exist_ok=True)
os.environ["HOME"] = str(PYTHON_HOME)
os.environ["XDG_CACHE_HOME"] = str(CACHE_HOME)

from localrouter import ReasoningConfig, TextBlock

from agentic_web import run_agentic_response


EDIT_SYSTEM_PROMPT = (
    "Rewrite the selected text according to the instruction. Return only replacement text."
)
COMMENT_SYSTEM_PROMPT = (
    "You are assisting inside a collaborative document comment thread. "
    "Reply directly and specifically. Only suggest replacement wording if the thread explicitly asks for wording."
)


@dataclass
class BenchmarkCase:
    name: str
    mode: str
    prompt: str
    expect_search: bool
    expected_domains: tuple[str, ...] = ()


CASES = [
    BenchmarkCase(
        name="edit_explicit_web_request",
        mode="edit",
        prompt=(
            "Update this sentence to reflect Nvidia's latest quarterly earnings. "
            "Use your web search tools before you rewrite it."
        ),
        expect_search=True,
        expected_domains=("investor.nvidia.com", "nvidianews.nvidia.com"),
    ),
    BenchmarkCase(
        name="edit_current_fact_helpful",
        mode="edit",
        prompt=(
            "Rewrite this sentence so it accurately references the latest US CPI inflation reading."
        ),
        expect_search=True,
        expected_domains=("bls.gov",),
    ),
    BenchmarkCase(
        name="edit_no_external_info_needed",
        mode="edit",
        prompt="Rewrite this sentence to be shorter and more direct.",
        expect_search=False,
    ),
    BenchmarkCase(
        name="comment_explicit_web_request",
        mode="comment",
        prompt=(
            "Can you use your web search tools and verify whether this sentence matches the latest US Federal Reserve policy rate?"
        ),
        expect_search=True,
        expected_domains=("federalreserve.gov",),
    ),
    BenchmarkCase(
        name="comment_no_external_info_needed",
        mode="comment",
        prompt="Does this paragraph sound too repetitive?",
        expect_search=False,
    ),
]


def build_edit_content(prompt: str) -> list:
    return [
        TextBlock(
            text=(
                "Document title: Market note\n"
                "Full document:\n"
                "The economy is evolving quickly.\n\n"
                "Selected text:\n"
                "The company recently reported strong earnings.\n\n"
                "Selected text with surrounding context:\n"
                "The company recently reported strong earnings. Investors responded positively.\n\n"
                f"Instruction:\n{prompt}\n\n"
                "Return only the new text that should replace the selected text."
            )
        )
    ]


def build_comment_content(prompt: str) -> list:
    return [
        TextBlock(
            text=(
                "Document title: Economic memo\n"
                "Selected text: The Fed's current policy rate is 4.5%.\n"
                "Selected text context: The memo discusses current macroeconomic conditions.\n"
                "Human requester: Niels\n\n"
                "Thread transcript:\n"
                f"Niels: {prompt}\n"
            )
        )
    ]


async def run_case(case: BenchmarkCase) -> dict:
    if case.mode == "edit":
        response = await run_agentic_response(
            model=os.getenv("AI_COMMENT_MODEL", "gpt-5.4"),
            system_prompt=EDIT_SYSTEM_PROMPT,
            user_content=build_edit_content(case.prompt),
            max_tokens=600,
        )
    else:
        response = await run_agentic_response(
            model=os.getenv("AI_COMMENT_MODEL", "gpt-5.4"),
            system_prompt=COMMENT_SYSTEM_PROMPT,
            user_content=build_comment_content(case.prompt),
            max_tokens=1200,
            reasoning=ReasoningConfig(effort="none"),
        )

    trace = response.meta.get("agentic_trace", [])
    tool_names = [item.get("tool") for item in trace]
    search_count = sum(1 for name in tool_names if isinstance(name, str) and "search" in name)
    browse_count = sum(
        1 for name in tool_names if isinstance(name, str) and (name.endswith("__fetch") or "browse" in name)
    )
    search_result_count = sum(
        int(item.get("result_count") or 0)
        for item in trace
        if isinstance(item.get("tool"), str) and "search" in item.get("tool")
    )
    domain_hits = 0
    if case.expected_domains:
        for item in trace:
            haystacks = [str(item.get("output_preview", "")).lower()]
            if item.get("tool") == "browse_page":
                haystacks.append(str(item.get("input", {}).get("url", "")).lower())
            if any(domain in haystack for haystack in haystacks for domain in case.expected_domains):
                domain_hits += 1
    answer = "\n".join(
        block.text for block in response.content if isinstance(block, TextBlock)
    ).strip()

    return {
        "name": case.name,
        "mode": case.mode,
        "expect_search": case.expect_search,
        "search_count": search_count,
        "browse_count": browse_count,
        "search_result_count": search_result_count,
        "domain_hits": domain_hits,
        "search_used": search_count > 0,
        "passed": (
            (search_count > 0 and search_result_count > 0 and (domain_hits > 0 if case.expected_domains else True))
            if case.expect_search
            else (search_count == 0)
        ),
        "explicit_tool_request": response.meta.get("explicit_tool_request"),
        "trace": trace,
        "answer_preview": answer[:500],
    }


async def main() -> None:
    results = []
    for case in CASES:
        print(f"Running {case.name}...", flush=True)
        results.append(await run_case(case))

    passed = sum(1 for result in results if result["passed"])
    report = {
        "model": os.getenv("AI_COMMENT_MODEL", "gpt-5.4"),
        "total_cases": len(results),
        "passed_cases": passed,
        "failed_cases": len(results) - passed,
        "results": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
