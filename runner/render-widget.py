#!/usr/bin/env python3
"""render-widget: screenshot a widget HTML file the way r-docs shows it.

Baked into the agent image so agents can LOOK at the charts they publish
(`Read` the PNG). The widget is loaded into an opaque-origin sandboxed iframe at
the document column width, with the same height bridge r-docs injects
(lib/widget-source.ts WIDGET_SIZE_BRIDGE — tests/render-widget.test.ts keeps the
copy below identical), and the iframe is resized from the bridge's messages
exactly like the document page does (min 120 px).

    render-widget widgets/chart.html                  # -> widgets/chart.png, 680 px wide
    render-widget widgets/chart.html --width 380      # phone width
    render-widget widgets/chart.html --out /tmp/c.png

Prints the frame height the page would give the widget. A widget whose content
sizes itself to its container (height: 100%, vh units, Plotly autosize without a
fixed height) never grows past the 120 px minimum — the chart is then cut off.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# Keep identical to WIDGET_SIZE_BRIDGE in lib/widget-source.ts.
BRIDGE = """<script data-gdocs-widget-bridge>(function(){
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
})();</script>"""

HOST = """<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:16px;background:#f1f3f4;font-family:Arial,sans-serif">
<div style="width:%(width)dpx;border:1px solid #dadce0;border-radius:8px;overflow:hidden;background:#fff">
<iframe id="f" sandbox="allow-scripts" style="display:block;width:100%%;border:0;height:120px;background:#fff"></iframe>
</div>
<div id="meta" style="margin-top:6px;font-size:12px;color:#5f6368"></div>
<script id="src" type="application/json">%(payload)s</script>
<script>
var f=document.getElementById("f");
f.srcdoc=JSON.parse(document.getElementById("src").textContent);
addEventListener("message",function(e){
  if(e.source!==f.contentWindow||!e.data||e.data.type!=="gdocs-widget-size")return;
  var h=Math.max(120,Math.min(8000,Math.round(e.data.height)));
  f.style.height=h+"px";
  document.getElementById("meta").textContent="frame height "+h+"px";
  document.body.setAttribute("data-frame-height",String(h));
});
</script></body></html>"""


def chromium_binary() -> str:
    for name in (os.environ.get("CHROMIUM"), "chromium", "chromium-browser", "google-chrome"):
        if name and shutil.which(name):
            return shutil.which(name)  # type: ignore[return-value]
    sys.exit("render-widget: no chromium binary found (set CHROMIUM=/path/to/chrome)")


def with_bridge(html: str) -> str:
    if "data-gdocs-widget-bridge" in html:
        return html
    close = html.lower().rfind("</body>")
    return html[:close] + BRIDGE + html[close:] if close >= 0 else html + BRIDGE


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("html")
    parser.add_argument("--width", type=int, default=680,
                        help="document column width in px (680 desktop, 380 phone)")
    parser.add_argument("--out", default=None, help="PNG path (default: next to the HTML)")
    parser.add_argument("--wait-ms", type=int, default=8000,
                        help="virtual time for scripts and CDN loads")
    args = parser.parse_args()

    html = with_bridge(open(args.html, encoding="utf-8").read())
    out = os.path.abspath(args.out or re.sub(r"\.html?$", "", args.html) + ".png")
    # "</" must not end the JSON <script> block early.
    payload = json.dumps(html).replace("</", "<\\/")
    with tempfile.TemporaryDirectory() as tmp:
        host = os.path.join(tmp, "host.html")
        with open(host, "w", encoding="utf-8") as fh:
            fh.write(HOST % {"width": args.width, "payload": payload})
        common = [chromium_binary(), "--headless=new", "--no-sandbox", "--disable-gpu",
                  "--hide-scrollbars", f"--user-data-dir={tmp}/profile",
                  f"--virtual-time-budget={args.wait_ms}"]
        dom = subprocess.run(common + ["--dump-dom", "file://" + host],
                             capture_output=True, text=True, timeout=120).stdout
        match = re.search(r'data-frame-height="(\d+)"', dom)
        height = int(match.group(1)) if match else 120
        subprocess.run(common + [f"--window-size={args.width + 32},{height + 60}",
                                 f"--screenshot={out}", "file://" + host],
                       capture_output=True, text=True, timeout=120, check=True)
    print(f"{out}  (frame {args.width}x{height}px)")
    if height <= 120:
        print("WARNING: the frame stayed at the 120 px minimum — the widget does not report "
              "its own height (fixed-pixel heights only: no height:100%, vh units or "
              "container-filling autosize). Readers see it cut off.")


if __name__ == "__main__":
    main()
