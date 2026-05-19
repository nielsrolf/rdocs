#!/usr/bin/env python3
"""Build assets/ai_modes_widget.html — a tiny interactive card explorer
for the three GDocs AI interaction modes."""

import os

HTML = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GDocs AI — Mode Explorer</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f8f9fa;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px 12px 32px;
    color: #1a1a2e;
  }
  h1 { font-size: 1.15rem; font-weight: 700; color: #111; margin-bottom: 4px; letter-spacing: -0.02em; }
  .sub { font-size: 0.78rem; color: #888; margin-bottom: 20px; }

  .cards {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
    width: 100%;
    max-width: 860px;
  }
  .card {
    flex: 1 1 220px;
    max-width: 280px;
    background: #fff;
    border-radius: 14px;
    padding: 18px 16px 16px;
    cursor: pointer;
    border: 2px solid #eee;
    transition: all 0.18s;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    position: relative;
  }
  .card:hover { transform: translateY(-3px); box-shadow: 0 6px 20px rgba(0,0,0,0.10); }
  .card.active { border-color: var(--accent); box-shadow: 0 6px 24px rgba(0,0,0,0.13); transform: translateY(-4px); }

  .card-icon { font-size: 1.8rem; margin-bottom: 8px; }
  .card-title { font-size: 0.95rem; font-weight: 700; color: var(--accent); margin-bottom: 4px; }
  .card-trigger { font-size: 0.72rem; color: #888; margin-bottom: 10px; font-style: italic; }
  .card-desc { font-size: 0.78rem; color: #444; line-height: 1.55; }

  .badge-row { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 10px; }
  .badge {
    font-size: 0.65rem; font-weight: 600; padding: 2px 8px; border-radius: 20px;
    background: var(--badge-bg); color: var(--accent);
  }

  /* Detail panel */
  .detail {
    margin-top: 20px;
    width: 100%;
    max-width: 860px;
    background: #fff;
    border-radius: 14px;
    padding: 20px 22px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    border-left: 5px solid #ccc;
    transition: border-color 0.2s;
    display: none;
  }
  .detail.visible { display: block; }
  .detail h2 { font-size: 0.95rem; font-weight: 700; margin-bottom: 12px; }
  .detail-grid { display: flex; gap: 20px; flex-wrap: wrap; }
  .detail-section { flex: 1 1 180px; }
  .detail-section h3 { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: #888; margin-bottom: 6px; }
  .detail-section ul { padding-left: 14px; }
  .detail-section li { font-size: 0.78rem; color: #333; margin-bottom: 4px; line-height: 1.45; }
  .output-pill {
    display: inline-block; font-size: 0.75rem; font-weight: 600;
    padding: 4px 12px; border-radius: 20px;
    background: var(--badge-bg); color: var(--accent);
    margin-top: 8px;
  }
  .tool-chip {
    display: inline-block; font-size: 0.68rem; font-weight: 600;
    padding: 2px 8px; border-radius: 12px;
    background: #f0f0f5; color: #444;
    margin: 2px;
  }
  .tool-chip.key { background: var(--badge-bg); color: var(--accent); }
</style>
</head>
<body>

<h1>GDocs AI — Mode Explorer</h1>
<p class="sub">Click a mode card to compare context, tools, and output contracts.</p>

<div class="cards" id="cards"></div>
<div class="detail" id="detail"></div>

<script>
const MODES = [
  {
    id: "edit",
    icon: "✏️",
    title: "Edit Request",
    trigger: "Highlight text → give instruction",
    desc: "AI rewrites or transforms the selected passage with full document and repo context.",
    accent: "#4f46e5",
    badgeBg: "#eef2ff",
    badges: ["Single-shot", "replacementText", "Figures", "Widgets"],
    context: [
      "System prompt (~400 tok)",
      "Full document body",
      "Selected text + surrounding context",
      "User instruction",
      "Repository checkout (optional)",
    ],
    tools: ["Read","Write","Edit","Bash","Glob","Grep","WebSearch","WebFetch","Agent"],
    keyTools: ["Read","Edit","Bash","Grep"],
    output: "JSON: replacementText + optional images[] + widgets[]",
    outputPill: "↩ replacementText",
  },
  {
    id: "comment",
    icon: "💬",
    title: "Comment Request",
    trigger: "Open thread → click Ask AI",
    desc: "AI reads the full thread and anchored passage, then posts a Markdown reply — no direct doc edits.",
    accent: "#0891b2",
    badgeBg: "#e0f7fa",
    badges: ["Single-shot", "Thread reply", "Figures", "No doc mutation"],
    context: [
      "System prompt (~400 tok)",
      "Full document body",
      "Anchor text",
      "Full comment thread (all turns)",
      "Latest user message",
    ],
    tools: ["Read","Write","Edit","Bash","Glob","Grep","WebSearch","WebFetch","Agent"],
    keyTools: ["Read","WebSearch","WebFetch"],
    output: "Markdown reply appended to thread",
    outputPill: "💬 Thread reply",
  },
  {
    id: "document",
    icon: "📄",
    title: "Document-level",
    trigger: "Open conversation panel → chat",
    desc: "Full multi-turn research session. The agent can run code, search the web, commit assets, and delegate to sub-agents.",
    accent: "#059669",
    badgeBg: "#d1fae5",
    badges: ["Multi-turn", "Stateful", "All tools", "Research tasks"],
    context: [
      "System prompt (~800 tok)",
      "Full document body",
      "All unresolved comment threads",
      "Repository worktree + README/CLAUDE.md",
      "Full conversation history (grows per turn)",
      "Current user message",
    ],
    tools: ["Read","Write","Edit","Bash","Glob","Grep","WebSearch","WebFetch","Agent",
            "TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate",
            "NotebookEdit","EnterWorktree","ExitWorktree"],
    keyTools: ["Agent","TaskCreate","Bash","WebSearch"],
    output: "Chat reply in conversation panel; assets committed to repo",
    outputPill: "🗣 Chat reply",
  },
];

let active = null;

function render() {
  const cardsEl = document.getElementById("cards");
  cardsEl.innerHTML = "";
  MODES.forEach(m => {
    const card = document.createElement("div");
    card.className = "card" + (active === m.id ? " active" : "");
    card.style.setProperty("--accent", m.accent);
    card.style.setProperty("--badge-bg", m.badgeBg);
    card.innerHTML = `
      <div class="card-icon">${m.icon}</div>
      <div class="card-title">${m.title}</div>
      <div class="card-trigger">${m.trigger}</div>
      <div class="card-desc">${m.desc}</div>
      <div class="badge-row">${m.badges.map(b => `<span class="badge">${b}</span>`).join("")}</div>
    `;
    card.onclick = () => { active = active === m.id ? null : m.id; render(); };
    cardsEl.appendChild(card);
  });

  const detailEl = document.getElementById("detail");
  if (!active) { detailEl.className = "detail"; return; }
  const m = MODES.find(x => x.id === active);
  detailEl.className = "detail visible";
  detailEl.style.setProperty("--accent", m.accent);
  detailEl.style.setProperty("--badge-bg", m.badgeBg);
  detailEl.style.borderLeftColor = m.accent;
  detailEl.innerHTML = `
    <h2 style="color:${m.accent}">${m.icon} ${m.title} — Detail</h2>
    <div class="detail-grid">
      <div class="detail-section">
        <h3>Context layers</h3>
        <ul>${m.context.map(c => `<li>${c}</li>`).join("")}</ul>
      </div>
      <div class="detail-section">
        <h3>Output contract</h3>
        <p style="font-size:0.78rem;color:#444;line-height:1.55">${m.output}</p>
        <span class="output-pill">${m.outputPill}</span>
      </div>
      <div class="detail-section">
        <h3>Available tools</h3>
        <div>
          ${m.tools.map(t => `<span class="tool-chip${m.keyTools.includes(t) ? " key" : ""}">${t}</span>`).join("")}
        </div>
        <p style="font-size:0.7rem;color:#888;margin-top:6px">Highlighted = most used in this mode</p>
      </div>
    </div>
  `;
}

render();
</script>
</body>
</html>
'''

os.makedirs("assets", exist_ok=True)
out = "assets/ai_modes_widget.html"
with open(out, "w") as f:
    f.write(HTML)
print(f"Saved {out} ({len(HTML):,} bytes)")
