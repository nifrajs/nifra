/**
 * The tiny, dependency-free client bridge injected into every `ui://` widget's HTML (MCP Apps / SEP-1865).
 * It speaks the MCP-JSON-RPC-over-`postMessage` subset a host exposes to an embedded UI:
 *
 *   host → widget : `ui/notifications/tool-result` (the tools/call result incl. `structuredContent`),
 *                   `ui/notifications/tool-input` (the call arguments), and `ui/notifications/theme`
 *                   (the host's design tokens) — pushed as JSON-RPC notifications.
 *   widget → host : `tools/call` requests (id-matched) so a button can re-invoke a tool through the host.
 *
 * Theming follows the shadcn/Tailwind semantic-token convention (`--background`, `--foreground`,
 * `--primary`, `--card`, `--border`, `--radius`, …). The host pushes its resolved tokens; the bridge
 * applies them to the document root, so a widget that styles with `var(--primary)` etc. matches the host
 * app (e.g. a builder-generated app injecting its theme preset) with zero per-widget work.
 *
 * It exposes a small global the widget author scripts against, so authoring a widget is just
 * `mcpApp.onData(render)` + (optionally) `mcpApp.callTool(name, args)` — no postMessage plumbing.
 *
 * Returned as a string so {@link ./widget.ts} can inline it in the resource HTML (a widget ships as ONE
 * self-contained document; the host renders it in a sandboxed iframe with no network of its own).
 */

/** The author-facing global injected into a widget. Kept minimal and stable. */
export interface McpAppBridge {
  /** Latest `structuredContent` the host pushed (or `null` before the first result). */
  data: unknown
  /** Register a callback for `structuredContent` — fired immediately if data already arrived, then on
   * every later `ui/notifications/tool-result`. The common case: `mcpApp.onData(render)`. */
  onData(cb: (data: unknown) => void): void
  /** Register a callback for the raw tool-call arguments (`ui/notifications/tool-input`). */
  onInput(cb: (args: unknown) => void): void
  /** Latest theme the host pushed (`{ mode, tokens }`), or `null` before the first push. */
  theme: unknown
  /** Register a callback for host theme pushes. The bridge ALSO auto-applies the tokens to the document
   * root (shadcn semantic vars + `color-scheme`/`data-theme`), so most widgets need no theme code. */
  onTheme(cb: (theme: unknown) => void): void
  /** Invoke a tool back through the host; resolves with the tools/call result. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>
}

/** The bridge source, as a string for inlining in a `<script>`. Self-contained, no imports. */
export function bridgeScript(): string {
  return BRIDGE_SOURCE
}

// Authored as a plain string (not a function we `.toString()`) so a bundler/minifier can't rename the
// global or strip it, and so it has zero dependency on this module's runtime. Intentionally ES5-ish for
// maximal host/iframe compatibility.
const BRIDGE_SOURCE = `(function () {
  var pending = {};
  var nextId = 1;
  var dataCbs = [];
  var inputCbs = [];
  var themeCbs = [];
  function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    var root = document.documentElement;
    if (theme.mode === "light" || theme.mode === "dark") {
      root.setAttribute("data-theme", theme.mode);
      root.style.colorScheme = theme.mode;
    }
    var tokens = theme.tokens;
    if (tokens && typeof tokens === "object") {
      for (var k in tokens) {
        if (Object.prototype.hasOwnProperty.call(tokens, k)) {
          root.style.setProperty(k.charAt(0) === "-" ? k : "--" + k, String(tokens[k]));
        }
      }
    }
  }
  var api = {
    data: null,
    theme: null,
    onData: function (cb) {
      if (typeof cb !== "function") return;
      dataCbs.push(cb);
      if (api.data !== null) { try { cb(api.data); } catch (e) {} }
    },
    onInput: function (cb) { if (typeof cb === "function") inputCbs.push(cb); },
    onTheme: function (cb) {
      if (typeof cb !== "function") return;
      themeCbs.push(cb);
      if (api.theme !== null) { try { cb(api.theme); } catch (e) {} }
    },
    callTool: function (name, args) {
      var id = "w" + nextId++;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        post({ jsonrpc: "2.0", id: id, method: "tools/call", params: { name: name, arguments: args || {} } });
      });
    }
  };
  function post(msg) { try { (window.parent || window).postMessage(msg, "*"); } catch (e) {} }
  function emit(list, value) { for (var i = 0; i < list.length; i++) { try { list[i](value); } catch (e) {} } }
  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    // A response to one of our tools/call requests (id-matched).
    if (msg.id != null && pending[msg.id]) {
      var p = pending[msg.id]; delete pending[msg.id];
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    // A host → widget notification.
    if (msg.method === "ui/notifications/tool-result") {
      var params = msg.params || {};
      var structured = params.structuredContent != null ? params.structuredContent : params;
      api.data = structured;
      emit(dataCbs, structured);
    } else if (msg.method === "ui/notifications/tool-input") {
      emit(inputCbs, (msg.params || {}).arguments);
    } else if (msg.method === "ui/notifications/theme") {
      var theme = msg.params || {};
      api.theme = theme;
      applyTheme(theme);
      emit(themeCbs, theme);
    }
  });
  window.mcpApp = api;
  // Some hosts wait for the iframe to signal readiness before pushing data; harmless if ignored.
  post({ jsonrpc: "2.0", method: "ui/notifications/ready" });
})();`
