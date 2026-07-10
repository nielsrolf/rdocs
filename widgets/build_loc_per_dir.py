#!/usr/bin/env python3
"""Generate a bar chart of lines-of-code per top-level source directory.

Counts lines in common source-file extensions (.ts/.tsx/.js/.jsx/.mjs/.prisma/
.css/.sh), skipping node_modules/.next/build output. Writes a static PNG to
assets/loc_per_dir.png. Deterministic given the current repo contents.

Run from the repo root: python3 widgets/build_loc_per_dir.py
"""
import os
import subprocess
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXTENSIONS = (
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".prisma", ".css", ".sh",
)

TOP_LEVEL_DIRS = [
    "app",
    "components",
    "lib",
    "tests",
    "agent-core",
    "e2e",
    "runner",
    "scripts",
    "prisma",
    "public",
    "types",
]

EXCLUDE_DIR_PARTS = {"node_modules", ".next", ".git", ".research-workspaces", "dist", "build"}


def count_lines_in_dir(rel_dir: str) -> int:
    total = 0
    abs_dir = os.path.join(REPO_ROOT, rel_dir)
    for root, dirs, files in os.walk(abs_dir):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIR_PARTS]
        for name in files:
            if name.endswith(EXTENSIONS):
                path = os.path.join(root, name)
                try:
                    with open(path, "r", encoding="utf-8", errors="ignore") as f:
                        total += sum(1 for _ in f)
                except OSError:
                    pass
    return total


def count_top_level_files() -> int:
    total = 0
    for name in os.listdir(REPO_ROOT):
        path = os.path.join(REPO_ROOT, name)
        if os.path.isfile(path) and name.endswith(EXTENSIONS):
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    total += sum(1 for _ in f)
            except OSError:
                pass
    return total


def main():
    counts = {}
    for d in TOP_LEVEL_DIRS:
        if os.path.isdir(os.path.join(REPO_ROOT, d)):
            counts[d] = count_lines_in_dir(d)
    counts["(root files)"] = count_top_level_files()

    # Drop empty/negligible entries and sort descending for readability.
    counts = {k: v for k, v in counts.items() if v > 0}
    items = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    labels = [k for k, _ in items]
    values = [v for _, v in items]

    fig, ax = plt.subplots(figsize=(8, 5), dpi=150)
    bars = ax.bar(labels, values, color="#4C6EF5")
    ax.set_ylabel("Lines of code")
    ax.set_title("Lines of code per top-level directory")
    ax.bar_label(bars, padding=3, fontsize=8)
    plt.xticks(rotation=35, ha="right")
    fig.tight_layout()

    out_path = os.path.join(REPO_ROOT, "assets", "loc_per_dir.png")
    fig.savefig(out_path)
    print(f"Wrote {out_path}")
    for label, value in items:
        print(f"  {label}: {value}")


if __name__ == "__main__":
    main()
