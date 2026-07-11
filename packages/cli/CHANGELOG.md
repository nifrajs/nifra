# @nifrajs/cli

## 1.4.0

### Patch Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.
- Updated dependencies [4d25970]
  - @nifrajs/core@1.4.0
  - @nifrajs/schema@1.4.0
  - @nifrajs/web@1.4.0
  - @nifrajs/client@1.4.0
  - @nifrajs/mcp@1.4.0
  - @nifrajs/runner@1.4.0
  - create-nifra@1.4.0

## 1.3.1

### Patch Changes

- 578da89: fix(cli): refresh the `nifra mcp` types/examples corpus for the 1.3.0 API + gate it

  `@nifrajs/cli` bundles the MCP corpus (`docs/types.json` / `examples.json`) behind `nifra_types` and
  `nifra_context`. It shipped **stale in 1.3.0** — the release regenerated `api-reference.md` + the LLM cards
  but not this corpus — so agents couldn't see `server().tool()` / `.resource()` / `.prompt()`,
  `onValidationError`, `RouteSchema.errors`, `ToolAnnotations`, or `generateLlmsTxt` via MCP. Regenerated.

  To prevent recurrence: `changeset:publish` now runs `gen:llms` after the build, so every published tarball
  carries a corpus regenerated from that exact build — the corpus can no longer ship stale regardless of what's
  committed.

  - @nifrajs/client@1.3.1
  - @nifrajs/mcp@1.3.1
  - @nifrajs/runner@1.3.1
  - @nifrajs/schema@1.3.1
  - @nifrajs/web@1.3.1
  - create-nifra@1.3.1

## 1.3.0

### Minor Changes

- 9f8d2aa: feat(cli): `nifra_check` / `nifra_test` MCP tools accept a `dir` to scope a subdirectory

  The MCP server runs at the project root, so `nifra check` / `nifra test` always ran from there — no way to
  target one app in a monorepo (a ShipNow pain: the root holds the builder + generated apps, but you want to
  check just `app/`). Both tools now take an optional `dir` (relative to the root, e.g. `"app"` or
  `"packages/api"`); the check/test runs against that subtree. Path-traversal-guarded — a `dir` that climbs
  out of the root (`../`, an absolute path elsewhere) is rejected, not run.

- 4a4b1c4: feat: `server().resource()` / `.prompt()` — app-declared MCP resources & prompts

  Completing the MCP trio alongside `.tool()`: an app can now expose its own MCP **resources**
  (`.resource(uri, { name, description?, mimeType? }, read)`) and **prompts** (`.prompt(name, { description,
arguments? }, handler)`). `nifra mcp` surfaces them in `resources/list` + `resources/read` and `prompts/list`

  - `prompts/get` (namespaced per app in a monorepo). The `read`/`handler` closures run in the app process, so
    they capture whatever app state they need — no HTTP round-trip.

### Patch Changes

- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
  - @nifrajs/mcp@1.3.0
  - @nifrajs/schema@1.3.0
  - @nifrajs/web@1.3.0
  - @nifrajs/client@1.3.0
  - @nifrajs/runner@1.3.0
  - create-nifra@1.3.0

## 1.2.2

### Patch Changes

- 281844e: fix(cli): `nifra check` respects `.gitignore` and bounds the MCP result

  Two fixes so `nifra check` (and the `nifra_check` MCP tool) can't drown in a repo full of generated apps:

  - **Scanner honours `.gitignore`** — `walkSource` now filters candidates through one batched
    `git check-ignore`, so a gitignored generated/build tree isn't walked. A repo that gitignores, e.g., a
    238-app generated-output dir went from a **52 MB** check result to ~130 KB. Degrades to the built-in
    ignore list (node_modules/dist/…) when there's no git repo — never throws.
  - **`nifra_check` MCP tool caps its output** — `collectCheckResult` gains `maxDiagnostics` (the tool sets 100) and reports `truncated: { shown, total }`, so a huge project can't emit an MCP message large enough
    to break the stdio transport (`-32000: Connection closed`). `ok` still reflects the FULL set; the CLI
    terminal / `--json` output stays unbounded.
  - @nifrajs/client@1.2.2
  - @nifrajs/mcp@1.2.2
  - @nifrajs/runner@1.2.2
  - @nifrajs/schema@1.2.2
  - @nifrajs/web@1.2.2
  - create-nifra@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [c3ebd73]
  - @nifrajs/web@1.2.1
  - @nifrajs/client@1.2.1
  - @nifrajs/mcp@1.2.1
  - @nifrajs/runner@1.2.1
  - @nifrajs/schema@1.2.1
  - create-nifra@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/client@1.2.0
- @nifrajs/schema@1.2.0
- @nifrajs/web@1.2.0
- @nifrajs/mcp@1.2.0
- @nifrajs/runner@1.2.0
- create-nifra@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [9905f7f]
- Updated dependencies [17e57c4]
- Updated dependencies [37d2383]
  - create-nifra@1.1.0
  - @nifrajs/schema@1.1.0
  - @nifrajs/web@1.1.0
  - @nifrajs/client@1.1.0
  - @nifrajs/mcp@1.1.0
  - @nifrajs/runner@1.1.0

## 1.0.0

### Minor Changes

- 5673ff1: `nifra_types` — a new MCP tool that returns the **exact TypeScript** of any exported `@nifrajs/*` symbol (interface, type, class, function, const). Each signature is generated at build time from the package's built `.d.ts` with the TS compiler — the literal declaration, complete and authoritative, never prose and never truncated — and shipped inside `@nifrajs/cli` (`docs/types.json`), so it works offline and on every transport (stdio, HTTP, the edge `/mcp`).

  This closes the gap that made agents fall back to reading `.d.ts`: when an agent needs the precise shape of a type (`RateLimitStore`, `RouteSchema`, a function signature), `nifra_types({ name })` returns the literal block. The tool description makes the completeness explicit ("the source of truth — do NOT read `.d.ts`"), and `nifra_docs` now points at it for exact types. `nifra_examples_app` on the public docs MCP, and the `@nifrajs/cli/mcp` self-host surface, both expose it too (`TypeEntry` is re-exported).

### Patch Changes

- c099d5f: Add `@nifrajs/mcp` — build MCP servers, and **MCP Apps** (interactive `ui://` widgets, SEP-1865), for a nifra app.

  MCP tools have only ever returned text. MCP Apps lets a tool return **interactive UI**: a tool links a `ui://` resource (MIME `text/html;profile=mcp-app`); the host renders it in a sandboxed iframe and bridges it to the server over MCP-JSON-RPC-on-`postMessage`. `@nifrajs/mcp` ships:

  - The transport-agnostic JSON-RPC core (`handleRpc`, shared with `@nifrajs/cli`'s dev MCP) extended for MCP Apps — `structuredContent`, `_meta.ui.resourceUri`, and the `io.modelcontextprotocol/ui` capability.
  - `respondMcpHttp` — a Web `fetch` handler you mount at `POST /mcp`. nifra route handlers can return a raw `Response`, so mounting is one line per verb.
  - `defineMcpWidget` — author a `ui://` widget as one self-contained HTML doc with a tiny zero-dependency `postMessage` bridge inlined (`mcpApp.onData(render)` to render the host-pushed `structuredContent`; `mcpApp.callTool(...)` to re-invoke a tool through the host).
  - `defineMcpTool` + `createMcpServer` — wire tools to widgets and get a mountable server. See `examples/mcp-app/`.
  - `@nifrajs/mcp/react` — `reactWidget({ component })` authors a widget from a React component instead of an HTML string: the component is bundled for the browser (Bun.build) and re-renders on each `structuredContent` push over the bridge. `react`/`react-dom` resolve from the consumer; the core stays dependency-free.
  - **Host theming + render intent** (see `THEMING.md`). `defineMcpTool({ intent })` adds `_meta.ui.intent` (`table`/`list`/`form`/…) so a generative host (e.g. the ShipNow builder) renders `structuredContent` with its own themed component. For iframe widgets, the bridge handles a `ui/notifications/theme` push and auto-applies the host's shadcn/Tailwind semantic tokens (`--primary`, `--card`, `--border`, `--radius`, …) to the widget root — so a widget that styles with `hsl(var(--primary))` matches the embedding app with zero extra code.

  `@nifrajs/cli`'s MCP protocol core moved into `@nifrajs/mcp` (the CLI re-exports it); behavior is unchanged — a tool whose handler returns a plain `string` behaves exactly as before. nifra's own public docs MCP (nifra.dev `/mcp`) now also dogfoods this — `nifra_examples_app` renders the examples as an interactive widget.

- bb31594: Surface `@nifrajs/middleware` where agents look. The `nifra_context` conventions (and a scaffolded app's `AGENTS.md`) now carry a one-line pointer: cross-cutting concerns — rate limiting (`429`), CORS, security headers, body limits, auth, CSRF, IP restriction, caching, compression — are `app.use(...)` plugins in `@nifrajs/middleware`; call `nifra_docs("middleware")` for the full list. So an agent setting up routes finds the built-in middleware (it already shipped) without having to think to search for it.
- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` — no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` — route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` — a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` — inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` — WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` — closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` — static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` — widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` — the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.

- a001558: **MCP warm worker survives a single per-request cancel.** The warm `nifra_run`/`nifra_render` worker is shared across concurrent calls (its `pending` map is id-keyed so several requests can be outstanding at once). Cancelling one request used to kill the whole worker process, which rejected every other in-flight request and forced a cold rebuild — defeating the warm reuse + concurrency the tool is built for. A per-request cancel now drops only that request and leaves the worker hot; it's still replaced on file change as before.
- Updated dependencies [f1f0e18]
- Updated dependencies [c099d5f]
- Updated dependencies [bb31594]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/client@1.0.0
  - @nifrajs/web@1.0.0
  - @nifrajs/mcp@1.0.0
  - create-nifra@1.0.0
  - @nifrajs/schema@1.0.0
  - @nifrajs/runner@1.0.0

## 1.0.0-beta.4

### Patch Changes

- Updated dependencies [5181a35]
  - create-nifra@1.0.0-beta.4
  - @nifrajs/client@1.0.0-beta.4
  - @nifrajs/runner@1.0.0-beta.4
  - @nifrajs/schema@1.0.0-beta.4
  - @nifrajs/web@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/client@1.0.0-beta.3
- @nifrajs/runner@1.0.0-beta.3
- @nifrajs/schema@1.0.0-beta.3
- @nifrajs/web@1.0.0-beta.3
- create-nifra@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [5018546]
  - @nifrajs/web@0.1.0-beta.2
  - @nifrajs/client@0.1.0-beta.2
  - @nifrajs/runner@0.1.0-beta.2
  - @nifrajs/schema@0.1.0-beta.2
  - create-nifra@0.1.0-beta.2
