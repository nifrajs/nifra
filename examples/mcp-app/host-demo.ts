/**
 * A minimal "host harness" page — what an MCP Apps host (MCPJam, ChatGPT) does to render a widget, so the
 * example is viewable in a plain browser without one. It loads the REAL widget HTML into a sandboxed
 * iframe, then plays the host side of the bridge over `postMessage`: it pushes the tool's
 * `structuredContent` in (`ui/notifications/tool-result`) and answers the widget's `tools/call` requests
 * (the Refresh button) — exercising the actual widget bytes and the real bridge, end to end.
 */

/** Build the host-harness HTML embedding `widgetHtml` and feeding it `structuredContent`. */
export function hostDemoPage(widgetHtml: string, structuredContent: unknown): string {
  // Escape `<` so a `</script>` inside the widget HTML can't terminate this inline <script> early.
  const widget = JSON.stringify(widgetHtml).replace(/</g, "\\u003c")
  const data = JSON.stringify(structuredContent).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>nifra MCP App — host harness</title>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #f6f6f7; color: #1a1a1a; }
  header { padding: 16px 20px; border-bottom: 1px solid #e3e3e6; background: #fff; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header p { font-size: 13px; margin: 4px 0 0; color: #6b6b70; }
  main { padding: 24px; display: flex; justify-content: center; }
  .frame { width: 480px; background: #fff; border: 1px solid #e3e3e6; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  iframe { width: 100%; border: 0; display: block; height: 320px; }
</style>
</head>
<body>
<header>
  <h1>MCP Apps host harness</h1>
  <p>Rendering <code>ui://orders/table</code> — the real widget, driven over the postMessage bridge.</p>
</header>
<main><div class="frame"><iframe id="w" sandbox="allow-scripts" title="orders widget"></iframe></div></main>
<script>
  var WIDGET = ${widget};
  var DATA = ${data};
  var iframe = document.getElementById("w");
  function push(){ iframe.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: DATA } }, "*"); }
  window.addEventListener("message", function (e) {
    var msg = e.data;
    if (!msg || typeof msg !== "object") return;
    // Widget signalled ready → push its data.
    if (msg.method === "ui/notifications/ready") push();
    // Widget called a tool back (the Refresh button) → answer like the host would.
    if (msg.id != null && msg.method === "tools/call") {
      iframe.contentWindow.postMessage({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: DATA } }, "*");
    }
  });
  iframe.addEventListener("load", function(){ setTimeout(push, 50); });
  iframe.srcdoc = WIDGET;
</script>
</body>
</html>
`
}
