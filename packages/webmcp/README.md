# @nifrajs/webmcp

Typed WebMCP site tools plus a deterministic predictive-UI contract for Nifra applications.

WebMCP is the browser-local surface: compatible hosts discover tools from the page through
`document.modelContext.registerTool`. This package does not replace WebMCP or MCP. It makes one Nifra
core tool contract usable from a page-local agent while adding prediction, reconciliation, receipts, and
host-independent conformance tests.

```sh
bun add @nifrajs/webmcp
```

```ts
import { t } from "@nifrajs/schema"
import {
  defineAgentCapability,
  registerWebMcpTools,
} from "@nifrajs/webmcp"

const addItem = defineAgentCapability({
  name: "cart.add",
  description: "Add a product to the current cart.",
  input: t.object({ sku: t.string(), quantity: t.number() }),
  output: t.object({ cartVersion: t.string() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  writes: ["cart"],
  execute: async (input) => addItemOnTheServer(input),
})

// Safe no-op on browsers/hosts without WebMCP.
const registration = await registerWebMcpTools([addItem])
```

The returned WebMCP `execute` function runs Nifra's existing input validation, capability, approval,
idempotency, budget, cancellation, output validation, and evidence path. By default it returns a bounded
receipt envelope so an agent can verify whether the operation committed. The normal human UI remains the
source of page rendering and works when WebMCP is absent.

Receipt output is retained only while its JSON encoding stays within the bounded `maxReceiptBytes`
limit (16 KiB by default, 64 KiB maximum); oversized or non-JSON output is represented by
`outputTruncated: true`. Use `resultMode: "output"` only when the embedding host provides its own
response-size and serialization boundary.

## Predictive UI

Predictions are application-owned and deterministic. They are not LLM guesses. Pair `predict` with
`reconcile`; prediction patches use an atomic, defensive subset of RFC 6902 (`add`, `replace`, `remove`):

```ts
const addItem = defineAgentCapability({
  // ...typed core tool options...
  predict: ({ input, snapshot, version }) => ({
    baseVersion: version,
    patch: [
      { op: "add", path: "/items/-", value: { sku: input.sku, quantity: input.quantity } },
    ],
  }),
  reconcile: ({ previous, output }) => ({
    state: { items: previous.state.items },
    version: output.cartVersion,
  }),
})
```

Use `createPredictionStore` and `executePredicted` for the full lifecycle:

```ts
const store = createPredictionStore({
  state: { items: [] },
  version: "cart-1",
})

const result = await executePredicted(addItem, input, store)
// committed | rolled-back | conflicted | expired | stale | invalid | executed
console.log(result.outcome, result.snapshot)
```

The store is atomic, defensive, expiry-aware, version-aware, and rejects prototype-grafting paths.
Successful server state replaces the authoritative base; failed calls roll the overlay back; stale
commits become conflicts.

## Remote MCP and MCP Apps

The capability contains the canonical `capability.tool`. Project it into the existing MCP adapter without
creating a second contract:

```ts
import { toMcpTool } from "@nifrajs/mcp/tool-contract"

const remoteTool = toMcpTool(addItem.tool, {
  capabilities: [addItem.tool.capability],
})
```

Use `@nifrajs/mcp`'s existing `defineMcpTool`, `structuredContent`, `ui://` widgets, and render intents
when the result should render as an MCP App. WebMCP is page-local; remote MCP remains available without an
open page.

## Security

- Register an explicit allowlist; never expose every route, DOM event, or `fetch` call.
- WebMCP registration is not authorization. Enforce authorization again at the server boundary.
- Keep inputs narrow and annotations honest. A safety hint is not a permission.
- Predictions are pure local transforms and cannot grant capability or bypass core policy.
- Receipts contain status, bounded evidence, and error codes—not credentials, request bodies, secrets, or
  stack traces.
- Normal browsers and non-WebMCP hosts receive a safe unsupported report.

## AI conformance

`runAgentSurfaceConformance` accepts an injectable host and optional deterministic calls, so CI can verify
the surface without ChatGPT or a live model:

```ts
const result = await runAgentSurfaceConformance([addItem], {
  target: fakeWebMcpHost,
  cases: [{ capability: addItem, input: { sku: "sku-1", quantity: 1 } }],
})
```

For the complete contract, see [`LLM.md`](./LLM.md), the repository [`AGENTS.md`](../../AGENTS.md), and
the root machine-readable [`llms-full.txt`](../../llms-full.txt) corpus.

See [`examples/webmcp`](../../examples/webmcp) for a complete capability projected to both WebMCP and
the existing remote MCP adapter.
