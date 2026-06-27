/**
 * MCP Apps dogfood for nifra's own public docs MCP (the `/mcp` endpoint of nifra.dev). nifra ships a
 * docs MCP built with `@nifrajs/cli`; here it ALSO becomes an MCP App — `nifra_examples_app` returns the
 * verified code examples as `structuredContent`, rendered by the {@link examplesWidget} `ui://` widget in
 * MCP Apps hosts (ChatGPT Apps, MCPJam, Goose). Additive: the existing text tools are untouched, and
 * text-only hosts still get the example list as plain text.
 */
import type { Example } from "@nifrajs/cli/mcp"
import { defineMcpTool, defineMcpWidget, type McpTool } from "@nifrajs/mcp"

/** The widget: renders `structuredContent.examples` as a filterable list of example cards. */
export const examplesWidget = defineMcpWidget({
  uri: "ui://nifra/examples",
  name: "nifra examples",
  description: "Interactive browser of verified, copy-pasteable nifra code examples.",
  head: `<style>
    :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    body { margin: 0; padding: 16px; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    #q { width: 100%; box-sizing: border-box; padding: 6px 10px; margin: 8px 0 14px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; font: inherit; }
    .card { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
    .topic { font-size: 12px; opacity: .6; }
    .name { font-weight: 600; margin: 2px 0 6px; }
    pre { margin: 0; padding: 8px 10px; border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent); overflow-x: auto; font: 12px/1.5 ui-monospace, monospace; }
  </style>`,
  html: `
    <h1>nifra examples</h1>
    <input id="q" placeholder="Filter examples…" />
    <div id="list"></div>
    <script>
      var ALL = [];
      function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return c==="&"?"&amp;":c==="<"?"&lt;":"&gt;"; }); }
      function paint(items){
        document.getElementById("list").innerHTML = items.map(function(e){
          var code = e.code.length > 600 ? e.code.slice(0, 600) + "\\n…" : e.code;
          return "<div class='card'><div class='topic'>" + esc(e.topic) + "</div><div class='name'>" + esc(e.name) +
            "</div><pre>" + esc(code) + "</pre></div>";
        }).join("") || "<p style='opacity:.6'>No matching examples.</p>";
      }
      function render(data){ ALL = (data && data.examples) || []; paint(ALL); }
      mcpApp.onData(render);
      document.getElementById("q").addEventListener("input", function(ev){
        var q = ev.target.value.toLowerCase();
        paint(ALL.filter(function(e){ return (e.topic + e.name + e.slug).toLowerCase().indexOf(q) !== -1; }));
      });
    </script>
  `,
})

/** The widget-backed tool. `loadExamples` is injected (disk on the CLI, cached fetch on the edge). */
export function examplesAppTool(loadExamples: () => Promise<Example[] | undefined>): McpTool {
  return defineMcpTool({
    name: "nifra_examples_app",
    description:
      "Browse nifra's verified code examples as an interactive, filterable list (MCP Apps widget). Pass query to pre-filter; the widget also filters client-side.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Pre-filter examples by keyword." } },
      additionalProperties: false,
    },
    widget: examplesWidget,
    handler: async (args) => {
      const all = (await loadExamples()) ?? []
      const q = ((args.query as string) ?? "").toLowerCase()
      const matched = (
        q
          ? all.filter((e) => `${e.topic} ${e.name} ${e.slug} ${e.code}`.toLowerCase().includes(q))
          : all
      ).slice(0, 30)
      return {
        text:
          matched.length === 0
            ? "No matching examples."
            : `${matched.length} example(s): ${matched.map((e) => e.name).join(", ")}.`,
        structuredContent: {
          examples: matched.map((e) => ({
            name: e.name,
            topic: e.topic,
            slug: e.slug,
            code: e.code,
          })),
        },
      }
    },
  })
}
