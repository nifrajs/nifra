/**
 * `defineMcpWidget` — author an MCP Apps (`ui://`) interactive widget for a nifra MCP server.
 *
 * A widget is ONE self-contained HTML document, served as an MCP resource with MIME {@link UI_MIME}. The
 * host renders it in a sandboxed iframe and pushes the linked tool's `structuredContent` in over the
 * {@link ./bridge.ts} bridge — so the author writes plain markup + `mcpApp.onData(render)`, no transport
 * glue. Link it to a tool with {@link ./tool.ts | defineMcpTool({ widget })}, which stamps the tool's
 * `_meta.ui.resourceUri` from {@link McpWidget.meta}.
 *
 * SECURITY: `structuredContent` (and any theme) arriving over the bridge is UNTRUSTED — escape it before
 * writing to `innerHTML`, or render with a framework that escapes (React/Preact, or `@nifrajs/mcp/react`).
 * The sandboxed iframe limits blast radius, but a widget that builds markup by string concatenation can
 * still XSS itself; the bridge passes data through, it does not sanitize.
 */

import { bridgeScript } from "./bridge.ts"
import { type McpResource, UI_MIME } from "./protocol.ts"

export interface DefineMcpWidgetOptions {
  /** The widget's resource URI — MUST use the `ui://` scheme, e.g. `ui://orders/table`. */
  readonly uri: string
  /** Human-readable name (shown by hosts that list resources). */
  readonly name: string
  readonly description?: string
  /** Document title (defaults to `name`). */
  readonly title?: string
  /** Extra `<head>` content — `<style>`, `<meta>`, fonts. The bridge `<script>` is injected for you. */
  readonly head?: string
  /** The widget body: markup plus a `<script>` that renders from `mcpApp.onData(...)` and may
   * `mcpApp.callTool(...)`. The bridge global is defined before this runs. */
  readonly html: string
}

/** The MCP Apps `_meta.ui.resourceUri` link. */
export function uiResourceMeta(uri: string): Record<string, unknown> {
  return { ui: { resourceUri: uri } }
}

/** A widget: the resource to register on the server, its `ui://` URI, and the `_meta` link for its tool. */
export interface McpWidget {
  readonly uri: string
  readonly resource: McpResource
  readonly meta: Record<string, unknown>
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"))
}

/** Assemble the full self-contained widget document (bridge inlined in `<head>` so body scripts can use
 * `mcpApp` immediately). */
export function widgetDocument(opts: DefineMcpWidgetOptions): string {
  const title = escapeHtml(opts.title ?? opts.name)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<script>${bridgeScript()}</script>
${opts.head ?? ""}
</head>
<body>
${opts.html}
</body>
</html>
`
}

export function defineMcpWidget(opts: DefineMcpWidgetOptions): McpWidget {
  if (!opts.uri.startsWith("ui://")) {
    throw new Error(`defineMcpWidget: uri must use the ui:// scheme (got "${opts.uri}")`)
  }
  const html = widgetDocument(opts)
  const resource: McpResource = {
    uri: opts.uri,
    name: opts.name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    mimeType: UI_MIME,
    read: () => Promise.resolve({ text: html, mimeType: UI_MIME }),
  }
  return { uri: opts.uri, resource, meta: uiResourceMeta(opts.uri) }
}
