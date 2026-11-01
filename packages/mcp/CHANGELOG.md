# @nifrajs/mcp

## 5.11.0

### Patch Changes

- @nifrajs/agent-protocol@5.11.0

## 5.10.0

### Patch Changes

- @nifrajs/agent-protocol@5.10.0

## 5.9.0

### Patch Changes

- 7ee17d0: `nifra check --sarif` and the command catalog's check output map report entries to diagnostics through one step. The CLI's page rules read the routes manifest and a `createWebApp` call's options through shared helpers, the layout migration applies its text edits through one function, two source scans share one route-registration reader, the two sync commands share their output schema and flag, and the Python and Go SDK generators share their setup and map-type reading.
  
  `create-nifra` passes the flags it parsed to `scaffold` as they are.
  
  `@nifrajs/web`'s PostCSS and Sass plugins build their JS module through one function, its client-build guards share one import-chain search, a page route's failed loaders answer through one step, and the router and the live client build a route data request's headers through one function.
  
  `@nifrajs/web-svelte`'s Svelte and MDX plugins emit scoped CSS through the stylesheet emitter in `@nifrajs/web/plugins/kit`, as the other kit plugins do. The virtual stylesheet import they write is now `?nifra-svelte-css` (`?nifra-svelte-mdx-css` for MDX), and its resolved path stays slash-separated on Windows.
  
  `@nifrajs/mcp` builds its capabilities once for `initialize` and `server/discover`. `@nifrajs/agent-review`'s composer uses the parser's outcome rule and evidence order, and the parser reads its two string lists through one reader. `@nifrajs/pi` reads message text through one helper, and core's evidence report sorts its findings through one comparator.
- Updated dependencies [5bc60b7]
  - @nifrajs/agent-protocol@5.9.0

## 5.8.0

### Patch Changes

- @nifrajs/agent-protocol@5.8.0

## 5.7.0

### Patch Changes

- @nifrajs/agent-protocol@5.7.0

## 5.6.0

### Minor Changes

- 4bc7d8d: `bundleReactWidget` in `@nifrajs/mcp/react` returns a React widget's body at build time, so a server running on Node or Deno serves it through `defineMcpWidget({ html })` without calling `Bun.build`.
- 4bc7d8d: `@nifrajs/mcp/stdio` serves an MCP server over stdin and stdout on Bun, Node and Deno: `serveStdio(createMcpServer({ ... }))` resolves once stdin ends and every pending request has answered, with progress notifications and request cancellation as over HTTP. `runStdioTransport` is the newline-delimited JSON-RPC framing underneath, with an 8 MiB cap per message in each direction.
  
  `nifra mcp` now runs on the same transport, which changes four edge cases:
  
  - A line that is not valid UTF-8 is answered with `-32700 parse error` and not dispatched; the invalid bytes were previously replaced with U+FFFD and the message ran.
  - A notification whose handler throws gets no reply, as JSON-RPC requires; it previously got an error response with a `null` id.
  - A last line without a trailing newline when stdin closes is processed; it was previously dropped.
  - When stdin closes, requests still running answer before the warm workers shut down; the workers previously closed at once.

### Patch Changes

- 0b9fed9: The documented nifra mount for `createMcpServer` routes `OPTIONS` as well as `GET` and `POST`: `server().use(method(["GET", "POST", "OPTIONS"], "/mcp", (c) => mcp.fetch(c.req)))`. A browser client on another origin sends a CORS preflight before its first POST, and that route lets `allowAnyOrigin` or `allowedOrigins` answer it. A mount with only `GET` and `POST` routes answers the preflight with 405, so the browser never sends the POST.
- Updated dependencies [2248445]
  - @nifrajs/agent-protocol@5.6.0

## 5.5.1

### Patch Changes

- @nifrajs/agent-protocol@5.5.1

## 5.5.0

### Patch Changes

- @nifrajs/agent-protocol@5.5.0

## 5.4.0

### Patch Changes

- @nifrajs/agent-protocol@5.4.0

## 5.3.0

### Patch Changes

- @nifrajs/agent-protocol@5.3.0

## 5.2.1

### Patch Changes

- @nifrajs/agent-protocol@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
  - @nifrajs/agent-protocol@5.2.0

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- 2b8f235: The HTTP transport no longer opens its GET server-message stream for a caller it has not checked. With `authorizeMessage` set, a GET that asks for `text/event-stream` is now answered `405` (the Streamable HTTP answer for "no stream offered here"), since that stream carries no message the callback could authorize; before, any caller could open one and hold it with keep-alive comments. Without `authorizeMessage`, the stream now closes after five minutes, and a client that wants it again reconnects. Nothing is sent on this stream, so no message is lost; tool calls and their progress still travel on the POST stream.
- Updated dependencies [abb4354]
  - @nifrajs/agent-protocol@5.1.0

## 5.0.0

### Minor Changes

- 1af7543: Event streams stay bounded for a client that stops reading. `mountAgent` takes `maxOutputBytes` (default 4 MiB): past it an SSE response ends with an `output_limit` error frame, and with an `evidenceLog` a `Last-Event-ID` reconnect reads on. `respondMcpHttp` and `createMcpServer` take `maxPendingBytes` (default 4 MiB): an SSE stream with more than that waiting for its client is dropped and its tool call cancelled. The coding agent's `turn.send` stream advances the backend only as the client reads, and a resumable follower that falls `replayBytes` behind is dropped and can attach again from its cursor.

### Patch Changes

- Updated dependencies [36bdc71]
- Updated dependencies [2198640]
- Updated dependencies [6b0db44]
- Updated dependencies [a3b3c51]
- Updated dependencies [6b96131]
- Updated dependencies [d6a7fa0]
- Updated dependencies [343bae0]
- Updated dependencies [b435f13]
- Updated dependencies [6340cd8]
- Updated dependencies [34b3014]
- Updated dependencies [848ce97]
- Updated dependencies [a0a02f4]
- Updated dependencies [0aed425]
- Updated dependencies [eaf030b]
- Updated dependencies [7de0397]
- Updated dependencies [1af7543]
- Updated dependencies [4199ff3]
- Updated dependencies [90d9ee6]
- Updated dependencies [364a234]
- Updated dependencies [c06cba5]
- Updated dependencies [f4d3852]
- Updated dependencies [4a82ae0]
- Updated dependencies [0ff867a]
- Updated dependencies [e7391bf]
- Updated dependencies [0b80a59]
- Updated dependencies [c64db12]
- Updated dependencies [3753104]
- Updated dependencies [4b3b1fa]
- Updated dependencies [3562557]
- Updated dependencies [53087f3]
- Updated dependencies [2def6c7]
- Updated dependencies [b5b5bc3]
- Updated dependencies [22e1777]
- Updated dependencies [3a483cd]
- Updated dependencies [35f52c7]
- Updated dependencies [343cb81]
- Updated dependencies [d91fd44]
- Updated dependencies [b13e071]
- Updated dependencies [077657f]
- Updated dependencies [a5963cb]
- Updated dependencies [05aac0e]
- Updated dependencies [1a6616f]
- Updated dependencies [7775c2b]
- Updated dependencies [846e2f6]
- Updated dependencies [aadd9fc]
- Updated dependencies [ea16748]
- Updated dependencies [fc0284a]
- Updated dependencies [5b22f4d]
- Updated dependencies [1b94593]
- Updated dependencies [9f58295]
- Updated dependencies [b9608ac]
- Updated dependencies [7a165de]
- Updated dependencies [4064f36]
- Updated dependencies [48aad8c]
- Updated dependencies [41050ed]
- Updated dependencies [fc837cb]
- Updated dependencies [b80ce77]
- Updated dependencies [9b1acc9]
- Updated dependencies [740109f]
- Updated dependencies [e0a25fe]
- Updated dependencies [3630b6e]
- Updated dependencies [1290c6d]
- Updated dependencies [d0a7d58]
  - @nifrajs/agent-protocol@5.0.0
  - @nifrajs/agent@5.0.0
  - @nifrajs/core@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/agent-protocol@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/agent-protocol@4.0.1

## 4.0.0

### Minor Changes

- d4d40a5: feat(mcp): `allowedHosts` DNS-rebinding guard

  `createMcpServer()`, `respondMcpHttp()`, and `serveDatabaseAsMcp()` accept `allowedHosts`. A
  request whose Host is not listed gets 403, with or without an Origin. Set it for servers on
  localhost or a private network, where a DNS-rebound page presents a matching Origin. The check reads
  the inbound `Host` header. Host names compare case-insensitively, an entry without a port matches any
  port, and an entry with a port matches the effective port, so `localhost:80` admits
  `http://localhost/`.

  The same-origin default now accepts an `https:` Origin on an `http:` request URL (a TLS-terminating
  proxy) and still rejects a downgrade.

- 9ccf198: `handleRpc` takes `exposeToolErrors`, which answers a throwing tool with `Tool execution failed: <message>` instead of the bare text. It is off by default, so a remote caller still sees nothing from an error message. `nifra mcp` turns it on for its stdio server, so the local agent sees why a project tool failed, for example the error that stopped the backend from loading.

### Patch Changes

- Updated dependencies [6695a23]
- Updated dependencies [7b2ff47]
- Updated dependencies [422248c]
- Updated dependencies [62115dd]
- Updated dependencies [dbc91b6]
- Updated dependencies [d2329f5]
- Updated dependencies [1eb77df]
- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/agent@4.0.0
  - @nifrajs/core@4.0.0
  - @nifrajs/agent-protocol@4.0.0

## 3.5.0

### Patch Changes

- @nifrajs/agent-protocol@3.5.0

## 3.4.0

### Minor Changes

- Harden MCP error responses and browser-origin defaults, confine scaffold writes to `routes/`, and
  make sanitized HTML require an explicit sanitizer function.

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- Updated dependencies [8d23613]
  - @nifrajs/agent-protocol@3.4.0

## 3.3.0

## 3.2.0

### Patch Changes

- 1a041a9: Add provider-neutral gateway and deployment contracts with deterministic reference adapters and evidence-safe policy checks.
- cefedc2: Stream progress notifications and final JSON-RPC responses over `text/event-stream`, and support
  cancellable SSE GET connections for Streamable HTTP clients.

## 3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- cb04de8: New `authorizeMessage` option on `createMcpServer` (and per request via
  `mcp.fetch(request, { authorizeMessage })`): a hook run once per parsed message, before any tool runs,
  that answers `403` with a JSON-RPC `unauthorized` error (`MCP_ERROR.UNAUTHORIZED`) when it returns
  `false`. The HTTP layer above an MCP mount only ever sees one opaque POST, so a route guard cannot
  express "this caller may list tools but may not call the write ones" - this is the seam that can. It
  runs after the body has been read under `maxBodyBytes`, so it costs no second read of the stream.
- e2d1939: Add typed tool contracts with shared fail-closed adapters, static verification work graphs, bounded provider-neutral agent turns, deterministic trajectory replay, and an explicit execution-policy seam with a non-isolating local process adapter.

### Patch Changes

- f3cc02e: `handleRpc` rejects a `tools/call` whose request id is already in flight, with
  `-32600 duplicate request id is already in progress`, instead of starting a second call under the same
  id. Registering the second call overwrote the first's `AbortController`, so `notifications/cancelled`
  for that id then cancelled only the newer call and left the earlier one running with nothing able to
  stop it. JSON-RPC requires an id to be unique among in-flight requests, so no conforming client is
  affected.

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

### Minor Changes

- 10fb70c: `defineMcpTool` accepts `annotations` (the MCP tool safety hints - `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`), surfaced in `tools/list` and `tools/describe`. Hosts use these to pick confirmation UX, and connector directory reviews expect every tool to declare them. The hosted docs tools (`nifra_docs`, `nifra_example`, `nifra_types`, `nifra_learn`, `nifra_examples_app`) now all declare themselves read-only and closed-world.

## 2.5.0

### Minor Changes

- 3731c69: Add the 2026-07-28 modern MCP transport alongside the handshake, so a server speaks both eras on one endpoint. It implements `server/discover` (advertising supported versions, capabilities, and identity), per-request protocol-version negotiation (an `UnsupportedProtocolVersionError` for a version the server does not speak), the `resultType` completion envelope with cache hints on list/read results, and - over HTTP - validation of the mirrored `Mcp-Method`/`Mcp-Name`/`MCP-Protocol-Version` headers against the request body (a `HeaderMismatch` answered with 400) plus the spec's status codes (404 for an unknown method). Clients that still use the `initialize` handshake are served exactly as before. `createMcpServer` and the HTTP handler gain an `instructions` field surfaced in discovery.
- 0740f77: Harden the Streamable HTTP transport so a hosted MCP server loads cleanly as a remote connector. The CORS preflight now allows the request headers browser-based clients send (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Authorization`, `Accept`, `Last-Event-ID`) and exposes the protocol-version header. `initialize` negotiates the protocol version, echoing the client's requested revision when the server also speaks it. Notifications are acknowledged with `202 Accepted`; a `GET` that requests `text/event-stream` returns `405`; and `respondMcpHttp` gains an `allowedOrigins` option that rejects any other browser origin with `403` as a DNS-rebinding guard (omitted by default, so a public server stays open).

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

### Major Changes

- d91a45b: Remove Nifra's remaining deprecated and compatibility-only public surfaces for the 2.0 cutover.

  - `@nifrajs/core` and `nifra` now expose only the lean HTTP server API at their package roots. Import
    optional systems from their documented subpaths. The deprecated invariant runner and the
    `@nifrajs/budget` compatibility package are removed; use `@nifrajs/testing` and
    `@nifrajs/core/budget` respectively.
  - Web redirects accept only an options object as their second argument, the prerender enumeration
    wrapper is removed in favor of `enumerateStaticRoutes()`, and fragment navigation resolves IDs only.
  - MCP Apps metadata uses only `_meta.ui.resourceUri`; the deprecated flat `ui/resourceUri` key is gone.
  - Telemetry uses `ObservationAdapter` directly; the `AgentSpan`, `AgentSpanExporter`, and `SpanExporter`
    aliases are removed.
  - Invalid HTTP method overrides always fail closed with 400; the legacy ignore mode is removed.
  - `nifra build` always emits a complete target deploy directory and defaults to Bun. The old
    client-only build branch is removed; `nifra start` runs the generated Bun `server.js`.

### Minor Changes

- 202e758: Schema-typed MCP tools, and the default template demonstrates the contract.

  - `defineMcpTool` accepts `input`: a Standard Schema (nifra's `t`, zod, valibot, arktype, …) that
    validates every call's arguments before the handler runs and types the handler's `args`. Invalid
    arguments return an in-band `isError` result naming each issue, so a calling agent can correct
    and retry. Schemas that carry a JSON Schema (nifra's `t` does) become the advertised
    `inputSchema` automatically; an explicit `inputSchema` still overrides. The raw
    `inputSchema`-only form keeps working unchanged.
  - The `api` template's app now ships a `t`-validated route (body + response schemas) and its tests
    drive the app through `testClient` - the contract-first pitch is visible in the first file a new
    user opens, not just the docs.

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

### Patch Changes

- 3eb27ae: Internal tidy - remove a dead local variable in the query engine and clean up example wording in doc comments. No API or behavior change.

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

### Minor Changes

- 4a4b1c4: feat: MCP tool annotations on `server().tool()`

  `.tool()` config now accepts `annotations` - the MCP spec's per-tool safety hints (`title`, `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) - surfaced in `tools/list` and `tools/describe`. An
  agent can now tell a read-only tool from a destructive one and decide whether to auto-invoke or confirm
  first, instead of treating every exposed tool as equally risky.

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

### Minor Changes

- c099d5f: Add `@nifrajs/mcp` - build MCP servers, and **MCP Apps** (interactive `ui://` widgets, SEP-1865), for a nifra app.

  MCP tools have only ever returned text. MCP Apps lets a tool return **interactive UI**: a tool links a `ui://` resource (MIME `text/html;profile=mcp-app`); the host renders it in a sandboxed iframe and bridges it to the server over MCP-JSON-RPC-on-`postMessage`. `@nifrajs/mcp` ships:

  - The transport-agnostic JSON-RPC core (`handleRpc`, shared with `@nifrajs/cli`'s dev MCP) extended for MCP Apps - `structuredContent`, `_meta.ui.resourceUri`, and the `io.modelcontextprotocol/ui` capability.
  - `respondMcpHttp` - a Web `fetch` handler you mount at `POST /mcp`. nifra route handlers can return a raw `Response`, so mounting is one line per verb.
  - `defineMcpWidget` - author a `ui://` widget as one self-contained HTML doc with a tiny zero-dependency `postMessage` bridge inlined (`mcpApp.onData(render)` to render the host-pushed `structuredContent`; `mcpApp.callTool(...)` to re-invoke a tool through the host).
  - `defineMcpTool` + `createMcpServer` - wire tools to widgets and get a mountable server. See `examples/mcp-app/`.
  - `@nifrajs/mcp/react` - `reactWidget({ component })` authors a widget from a React component instead of an HTML string: the component is bundled for the browser (Bun.build) and re-renders on each `structuredContent` push over the bridge. `react`/`react-dom` resolve from the consumer; the core stays dependency-free.
  - **Host theming + render intent** (see `THEMING.md`). `defineMcpTool({ intent })` adds `_meta.ui.intent` (`table`/`list`/`form`/…) so a generative host renders `structuredContent` with its own themed component. For iframe widgets, the bridge handles a `ui/notifications/theme` push and auto-applies the host's shadcn/Tailwind semantic tokens (`--primary`, `--card`, `--border`, `--radius`, …) to the widget root - so a widget that styles with `hsl(var(--primary))` matches the embedding app with zero extra code.

  `@nifrajs/cli`'s MCP protocol core moved into `@nifrajs/mcp` (the CLI re-exports it); behavior is unchanged - a tool whose handler returns a plain `string` behaves exactly as before. nifra's own public docs MCP (nifra.dev `/mcp`) now also dogfoods this - `nifra_examples_app` renders the examples as an interactive widget.

### Patch Changes

- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` - no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` - route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` - a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` - inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` - WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` - closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` - static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` - widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` - the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.
