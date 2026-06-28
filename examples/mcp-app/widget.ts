/**
 * An MCP Apps (`ui://`) widget built with nifra. It renders the orders a tool returns as
 * `structuredContent`, and its "Refresh" button calls the tool back through the host bridge — so the same
 * widget is both a static display and a fully interactive app.
 *
 * Styled with the shadcn/Tailwind semantic tokens (`hsl(var(--primary))`, `var(--card)`, `var(--border)`,
 * `var(--radius)`, …) with sensible fallbacks. A host that pushes its theme over the bridge
 * (`ui/notifications/theme`) — e.g. a builder-generated app injecting its preset — restyles this widget to
 * match, with zero per-widget work. The author writes plain markup + `mcpApp.onData(render)` /
 * `mcpApp.callTool(...)`; `defineMcpWidget` inlines the bridge and serves it as `text/html;profile=mcp-app`.
 */
import { defineMcpWidget } from "@nifrajs/mcp"

export const ordersWidget = defineMcpWidget({
  uri: "ui://orders/table",
  name: "Orders table",
  description: "Interactive table of recent orders, fed by the list_orders tool.",
  head: `<style>
    :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    body { margin: 0; padding: 16px; background: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 224 24% 8%)); }
    .card { background: hsl(var(--card, 0 0% 100%)); border: 1px solid hsl(var(--border, 220 16% 90%)); border-radius: var(--radius, 10px); padding: 16px; }
    h1 { font-size: 16px; margin: 0 0 10px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid hsl(var(--border, 220 16% 90%)); }
    th { font-weight: 600; color: hsl(var(--muted-foreground, 220 10% 44%)); }
    td:last-child, th:last-child { text-align: right; font-variant-numeric: tabular-nums; }
    .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    #status { color: hsl(var(--muted-foreground, 220 10% 44%)); }
    button { font: inherit; padding: 6px 14px; border-radius: calc(var(--radius, 10px) - 2px); cursor: pointer; border: 1px solid transparent; background: hsl(var(--primary, 256 100% 67%)); color: hsl(var(--primary-foreground, 0 0% 100%)); }
  </style>`,
  html: `
    <div class="card">
      <h1>Orders</h1>
      <div class="bar"><span id="status">Loading…</span><button id="refresh">Refresh</button></div>
      <table><thead><tr><th>ID</th><th>Customer</th><th>Total</th></tr></thead><tbody id="rows"></tbody></table>
    </div>
    <script>
      function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return c==="&"?"&amp;":c==="<"?"&lt;":"&gt;"; }); }
      function render(data){
        var orders = (data && data.orders) || [];
        document.getElementById("status").textContent = orders.length + " order" + (orders.length===1?"":"s");
        document.getElementById("rows").innerHTML = orders.map(function(o){
          return "<tr><td>" + esc(o.id) + "</td><td>" + esc(o.customer) + "</td><td>$" + esc(o.total) + "</td></tr>";
        }).join("");
      }
      // Static path: render whatever structuredContent the host pushed for this tool call.
      mcpApp.onData(render);
      // Interactive path: re-invoke the tool through the host and re-render with the fresh result.
      document.getElementById("refresh").addEventListener("click", function(){
        mcpApp.callTool("list_orders").then(function(res){ render(res && res.structuredContent); });
      });
    </script>
  `,
})
