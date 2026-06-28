# MCP Apps theming + render-intent — the host/widget contract

How a host (e.g. the ShipNow builder) makes nifra MCP-App widgets and tool results match its design system.
A tool can serve **two** kinds of host from one definition:

- **Generative hosts** that render their OWN UI from data — they read `structuredContent` + `_meta.ui.intent`.
- **MCP Apps hosts** that render the server's `ui://` widget in a sandboxed iframe — they push theme tokens
  to it over the bridge.

## 1. Render intent (for generative hosts)

`defineMcpTool({ intent })` puts a hint at `_meta.ui.intent` describing how to present the result:

```ts
defineMcpTool({
  name: "list_orders",
  intent: "table",                       // → _meta.ui.intent
  handler: () => ({ structuredContent: { orders: [...] } }),
})
```

Vocabulary: `table | list | cards | form | metric | detail | chart` (or a custom string). A generative
host maps the intent + the tool's output schema to a component in its kit and renders `structuredContent`
with **its own** Tailwind/shadcn components — full theme control, nothing to restyle. The `ui://` widget is
optional and independent; a tool may offer both.

## 2. Theme tokens (for MCP Apps widgets)

A `ui://` widget is a sandboxed iframe — the host can't reach in and apply classes. Instead the host
**pushes its design tokens** and the widget reads them. The vocabulary is the **shadcn/Tailwind semantic
tokens** (the de-facto standard; what ShipNow's `@shipnow/ui` already uses):

```
--background --foreground --card --card-foreground --popover --popover-foreground
--primary --primary-foreground --secondary --secondary-foreground
--muted --muted-foreground --accent --accent-foreground
--destructive --destructive-foreground --border --input --ring --radius
```

Values follow shadcn convention (HSL triplets like `256 100% 67%`, used as `hsl(var(--primary))`).

**Host → widget**, over the existing postMessage bridge:

```json
{ "jsonrpc": "2.0", "method": "ui/notifications/theme",
  "params": { "mode": "light", "tokens": { "--primary": "256 100% 67%", "--card": "0 0% 100%", "--radius": "0.625rem", "...": "..." } } }
```

The `@nifrajs/mcp` bridge **auto-applies** this — it sets `data-theme`/`color-scheme` and writes each token
to the document root. A widget just styles with the vars (`background: hsl(var(--card))`,
`border-radius: var(--radius)`, …) and matches the host with no extra code. `mcpApp.onTheme(cb)` is there
for custom handling.

## What a host implements

1. On a tool result with `_meta.ui.intent`, render `structuredContent` with your own themed component.
2. On a tool result with `_meta.ui.resourceUri`, `resources/read` the `ui://` widget, embed it in a
   sandboxed iframe, and push `ui/notifications/theme` with your resolved tokens (+ on theme change).

See `examples/mcp-app/` — the widget styles with these tokens; the host harness pushes a ShipNow preset.
