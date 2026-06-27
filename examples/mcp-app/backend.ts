/**
 * An MCP App built with nifra — a normal nifra backend that also exposes an MCP server (with an
 * interactive `ui://` widget) at `POST /mcp`. Run it and point an MCP Apps host (MCPJam, ChatGPT Apps,
 * Goose) at the endpoint; calling `list_orders` renders the {@link ordersWidget} table.
 *
 *   bun run examples/mcp-app/server.ts
 *   curl -s localhost:3000/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_orders"}}'
 */
import { server } from "@nifrajs/core"
import { createMcpServer, defineMcpTool } from "@nifrajs/mcp"
import { reactWidget } from "@nifrajs/mcp/react"
import { hostDemoPage } from "./host-demo"
import { ordersWidget } from "./widget"

// In-memory demo data — single-process example only, NOT a production pattern.
const ORDERS = [
  { id: 1001, customer: "Ada Lovelace", total: 42 },
  { id: 1002, customer: "Alan Turing", total: 128 },
  { id: 1003, customer: "Grace Hopper", total: 7 },
]

/** The tool whose result renders as the interactive orders widget. `structuredContent` feeds the widget;
 * `text` is the model-facing summary (text-only hosts show this). */
const listOrders = defineMcpTool({
  name: "list_orders",
  description: "List recent orders and render them as an interactive table.",
  widget: ordersWidget,
  handler: () => ({
    text: `${ORDERS.length} orders: ${ORDERS.map((o) => o.customer).join(", ")}.`,
    structuredContent: { orders: ORDERS },
  }),
})

// The SAME widget, authored as a React component instead of an HTML string (@nifrajs/mcp/react). The
// component is bundled for the browser at startup and re-renders on each push over the bridge.
const ordersReactWidget = await reactWidget({
  uri: "ui://orders/react-table",
  name: "Orders (React)",
  description: "The orders widget authored as a React component.",
  component: `${import.meta.dir}/OrdersTableWidget.tsx`,
})

const listOrdersReact = defineMcpTool({
  name: "list_orders_react",
  description: "List recent orders, rendered by a React-component widget.",
  widget: ordersReactWidget,
  handler: () => ({
    text: `${ORDERS.length} orders (React widget).`,
    structuredContent: { orders: ORDERS },
  }),
})

const mcp = createMcpServer({
  name: "orders-mcp",
  version: "1.0.0",
  tools: [listOrders, listOrdersReact],
  widgets: [ordersWidget, ordersReactWidget],
  health: "orders MCP App (nifra) — POST JSON-RPC 2.0 here. Tools: list_orders, list_orders_react.",
})

/** The nifra app. Handlers may return a raw `Response`, so mounting the MCP server is one line per verb. */
export const app = server()
  .get("/mcp", (c) => mcp.fetch(c.req))
  .post("/mcp", (c) => mcp.fetch(c.req))
  // Browser-viewable host harnesses (what an MCP Apps host does) so the widgets are visible without one.
  .get("/", async () => {
    const widgetHtml = (await ordersWidget.resource.read()).text
    return new Response(hostDemoPage(widgetHtml, { orders: ORDERS }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  })
  .get("/react", async () => {
    const widgetHtml = (await ordersReactWidget.resource.read()).text
    return new Response(hostDemoPage(widgetHtml, { orders: ORDERS }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  })

export type App = typeof app
