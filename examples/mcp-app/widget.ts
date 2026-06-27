/**
 * An MCP Apps (`ui://`) widget built with nifra. It renders the orders a tool returns as
 * `structuredContent`, and its "Refresh" button calls the tool back through the host bridge — so the same
 * widget is both a static display and a fully interactive app. The author writes plain markup +
 * `mcpApp.onData(render)` / `mcpApp.callTool(...)`; `defineMcpWidget` inlines the bridge and serves it as a
 * `text/html;profile=mcp-app` resource.
 */
import { defineMcpWidget } from "@nifrajs/mcp"

export const ordersWidget = defineMcpWidget({
  uri: "ui://orders/table",
  name: "Orders table",
  description: "Interactive table of recent orders, fed by the list_orders tool.",
  head: `<style>
    :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    body { margin: 0; padding: 16px; }
    h1 { font-size: 16px; margin: 0 0 8px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
    th { font-weight: 600; opacity: .7; }
    td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
    .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    button { font: inherit; padding: 4px 12px; border-radius: 6px; cursor: pointer; }
    #status { opacity: .7; }
  </style>`,
  html: `
    <h1>Orders</h1>
    <div class="bar"><span id="status">Loading…</span><button id="refresh">Refresh</button></div>
    <table><thead><tr><th>ID</th><th>Customer</th><th>Total</th></tr></thead><tbody id="rows"></tbody></table>
    <script>
      function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return c==="&"?"&amp;":c==="<"?"&lt;":"&gt;"; }); }
      function render(data){
        var orders = (data && data.orders) || [];
        document.getElementById("status").textContent = orders.length + " order" + (orders.length===1?"":"s");
        document.getElementById("rows").innerHTML = orders.map(function(o){
          return "<tr><td>" + esc(o.id) + "</td><td>" + esc(o.customer) + "</td><td>$" + esc(o.total) + "</td></tr>";
        }).join("");
      }
      // 1) Static path: render whatever structuredContent the host pushed for this tool call.
      mcpApp.onData(render);
      // 2) Interactive path: re-invoke the tool through the host and re-render with the fresh result.
      document.getElementById("refresh").addEventListener("click", function(){
        mcpApp.callTool("list_orders").then(function(res){ render(res && res.structuredContent); });
      });
    </script>
  `,
})
