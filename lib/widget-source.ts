import fs from "node:fs/promises";
import path from "node:path";

// Resolve a widget's embed_source HTML from one or more candidate workspaces.
// Extracted from the widget source route so the path logic is unit-testable —
// "widgets would not appear because of false paths of saved assets" was a real
// bug class. The candidate order matters: the base checkout is tried first
// (after a run merges, the asset lives there and the per-run worktree may have
// been garbage-collected), then the run's recorded workspacePath as a fallback.

export async function tryReadEmbedSource(workspace: string, embedSource: string): Promise<string | null> {
  const sourcePath = path.resolve(workspace, embedSource);
  const workspaceRoot = path.resolve(workspace);
  // Containment guard: never read outside the workspace (rejects ../ traversal).
  if (!sourcePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    return null;
  }
  try {
    return await fs.readFile(sourcePath, "utf8");
  } catch {
    return null;
  }
}

export async function readEmbedSourceFromCandidates(
  candidates: Array<string | null | undefined>,
  embedSource: string
): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const html = await tryReadEmbedSource(candidate, embedSource);
    if (html !== null) {
      return html;
    }
  }
  return null;
}

// Widgets run in an opaque-origin iframe, so the parent cannot inspect their DOM
// to autosize them. Inject a tiny one-way bridge that reports only a bounded
// content height. The parent validates event.source and ignores every other
// message; no app data or capabilities are exposed to the widget.
const WIDGET_SIZE_BRIDGE = `<script data-gdocs-widget-bridge>(function(){
  var send=function(){
    var d=document.documentElement,b=document.body;
    var h=Math.max(d?d.scrollHeight:0,d?d.offsetHeight:0,b?b.scrollHeight:0,b?b.offsetHeight:0);
    parent.postMessage({type:"gdocs-widget-size",height:Math.max(120,Math.min(8000,h||120))},"*");
  };
  addEventListener("load",send);
  if(typeof ResizeObserver!=="undefined"){
    var ro=new ResizeObserver(send);
    if(document.documentElement)ro.observe(document.documentElement);
    if(document.body)ro.observe(document.body);
  }
  if(document.body&&typeof MutationObserver!=="undefined")new MutationObserver(send).observe(document.body,{childList:true,subtree:true,attributes:true});
  send();
})();</script>`;

export function addWidgetIsolationBridge(html: string): string {
  if (html.includes("data-gdocs-widget-bridge")) return html;
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose >= 0) {
    return `${html.slice(0, bodyClose)}${WIDGET_SIZE_BRIDGE}${html.slice(bodyClose)}`;
  }
  return `${html}${WIDGET_SIZE_BRIDGE}`;
}
