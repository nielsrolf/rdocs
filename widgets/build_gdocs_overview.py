#!/usr/bin/env python3
"""Generate assets/gdocs_overview.png — a visual summary of GDocs AI's three
AI interaction modes and their approximate context-window composition."""

import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

os.makedirs("assets", exist_ok=True)

# ── Data ──────────────────────────────────────────────────────────────────────
MODES = ["Edit\nRequest", "Comment\nRequest", "Document-level\nSession"]
COLORS_ACCENT = ["#4f46e5", "#0891b2", "#059669"]
COLORS_BG     = ["#eef2ff", "#e0f7fa", "#d1fae5"]

# Context layers per mode (label, approximate token weight for the bar chart)
LAYERS = {
    "Edit\nRequest": [
        ("System prompt",         400,  "#a5b4fc"),
        ("Document body",         1200, "#818cf8"),
        ("Selection + context",   200,  "#6366f1"),
        ("User instruction",      50,   "#4f46e5"),
        ("Repository (optional)", 600,  "#3730a3"),
    ],
    "Comment\nRequest": [
        ("System prompt",         400,  "#7dd3fc"),
        ("Document body",         1200, "#38bdf8"),
        ("Anchor text",           100,  "#0ea5e9"),
        ("Thread history",        500,  "#0891b2"),
        ("Latest message",        80,   "#0e7490"),
    ],
    "Document-level\nSession": [
        ("System prompt",         800,  "#6ee7b7"),
        ("Document body",         1200, "#34d399"),
        ("Unresolved threads",    600,  "#10b981"),
        ("Repository context",    500,  "#059669"),
        ("Conversation history",  1500, "#047857"),
        ("User message",          80,   "#065f46"),
    ],
}

TOOL_COUNTS = [9, 9, 19]  # available tools per mode

# ── Figure ────────────────────────────────────────────────────────────────────
fig = plt.figure(figsize=(13, 6.2), facecolor="#f8f9fa")
fig.suptitle("GDocs AI — Interaction Modes at a Glance",
             fontsize=14, fontweight="bold", color="#111", y=0.97)

gs = fig.add_gridspec(1, 4, left=0.05, right=0.97, top=0.88, bottom=0.08,
                      wspace=0.35)

# ── Left panel: stacked bar chart ─────────────────────────────────────────────
ax_bar = fig.add_subplot(gs[0, :3])
ax_bar.set_facecolor("#f8f9fa")
ax_bar.spines[["top", "right"]].set_visible(False)
ax_bar.spines[["left", "bottom"]].set_color("#ddd")
ax_bar.tick_params(colors="#555")

x = np.arange(len(MODES))
bar_w = 0.52
bottoms = np.zeros(len(MODES))

legend_patches = []
all_labels = ["System prompt", "Document body", "Selection / Anchor",
              "Thread / Instruction", "User instruction", "Repository",
              "Conversation history", "User message"]

for mode_i, mode in enumerate(MODES):
    layers = LAYERS[mode]
    for layer_label, tokens, color in layers:
        ax_bar.bar(mode_i, tokens, bar_w,
                   bottom=bottoms[mode_i],
                   color=color, linewidth=0)
        if tokens >= 250:
            ax_bar.text(mode_i,
                        bottoms[mode_i] + tokens / 2,
                        layer_label,
                        ha="center", va="center",
                        fontsize=6.5, color="white", fontweight="600")
        bottoms[mode_i] += tokens

# Tool count overlay
for i, (n, accent) in enumerate(zip(TOOL_COUNTS, COLORS_ACCENT)):
    ax_bar.text(i, bottoms[i] + 60,
                f"{n} tools",
                ha="center", va="bottom",
                fontsize=8, fontweight="bold", color=accent)

ax_bar.set_xticks(x)
ax_bar.set_xticklabels(MODES, fontsize=10, color="#222")
ax_bar.set_ylabel("Approximate context tokens", fontsize=9, color="#555")
ax_bar.set_ylim(0, max(bottoms) * 1.15)
ax_bar.yaxis.set_tick_params(labelsize=8)
ax_bar.set_title("Context window composition per mode",
                 fontsize=10, color="#444", pad=8)

# ── Right panel: output contract summary ──────────────────────────────────────
ax_info = fig.add_subplot(gs[0, 3])
ax_info.set_axis_off()
ax_info.set_facecolor("#f8f9fa")

CONTRACTS = [
    ("✏️ Edit", "Returns\nreplacementText\n+ optional figures\n+ optional widgets"),
    ("💬 Comment", "Appends Markdown\nreply to thread\n(no doc mutation)"),
    ("📄 Doc-level", "Chat reply in\nconversation panel;\nassets committed\nto repo"),
]

y0 = 0.95
for (label, contract), accent, bg in zip(CONTRACTS, COLORS_ACCENT, COLORS_BG):
    rect = mpatches.FancyBboxPatch(
        (0.0, y0 - 0.28), 1.0, 0.27,
        boxstyle="round,pad=0.03",
        facecolor=bg, edgecolor=accent, linewidth=1.5,
        transform=ax_info.transAxes, clip_on=False
    )
    ax_info.add_patch(rect)
    ax_info.text(0.08, y0 - 0.05, label,
                 transform=ax_info.transAxes,
                 fontsize=8.5, fontweight="bold", color=accent, va="top")
    ax_info.text(0.08, y0 - 0.10, contract,
                 transform=ax_info.transAxes,
                 fontsize=7.5, color="#333", va="top", linespacing=1.55)
    y0 -= 0.33

ax_info.set_title("Output\ncontracts", fontsize=9.5, color="#444", pad=8)

# ── Save ──────────────────────────────────────────────────────────────────────
out = "assets/gdocs_overview.png"
fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="#f8f9fa")
plt.close(fig)
print(f"Saved {out}")
