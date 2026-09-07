import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

export const hydrate = false

export const meta = docsMeta(
  "/docs/webmcp",
  "Nifra - WebMCP & predictive UI",
  "Expose explicit page-local WebMCP tools from typed Nifra capabilities while keeping remote MCP, authorization, receipts, and predictive UI reconciliation on one contract.",
)

const CAPABILITY = `// doc-check: skip - addItemOnServer is supplied by the application.
import { t } from "@nifrajs/schema"
import { defineAgentCapability } from "@nifrajs/webmcp"

export const addToCart = defineAgentCapability({
  name: "cart.add",
  description: "Add a product to the current cart.",
  input: t.object({ sku: t.string(), quantity: t.number() }),
  output: t.object({ cartVersion: t.string() }),
  annotations: { readOnlyHint: false, destructiveHint: false },
  writes: ["cart"],
  execute: (input) => addItemOnServer(input),
})`

const WEBMCP = `// doc-check: skip - addToCart is declared in the preceding section.
import { registerWebMcpTools } from "@nifrajs/webmcp"

// Explicit allowlist. On ordinary browsers this resolves to a safe unsupported report.
const registration = await registerWebMcpTools([addToCart])
console.log(registration.supported, registration.registered, registration.failed)
// The host receives the standard document.modelContext.registerTool({
//   name, description, inputSchema, annotations, execute
// }) shape.`

const MCP = `// doc-check: skip - addToCart is declared in the preceding section.
import { toMcpTool } from "@nifrajs/mcp/tool-contract"

// Same core schemas, authorization, approval, idempotency, and evidence - different transport.
const remoteTool = toMcpTool(addToCart.tool, {
  capabilities: [addToCart.tool.capability],
})`

const PREDICTION = `// doc-check: skip - addToCart is declared in the preceding section.
import { createPredictionStore, executePredicted } from "@nifrajs/webmcp"

const store = createPredictionStore({ state: { items: [] }, version: "cart-1" })
const result = await executePredicted(addToCart, { sku: "sku-1", quantity: 1 }, store)
// committed | rolled-back | conflicted | expired | stale | invalid | executed
console.log(result.outcome, result.snapshot)
// predict is a pure RFC 6902 subset patch; reconcile accepts the authoritative server version.`

export default function WebMcp() {
  return (
    <div className="prose">
      <h1 className="page">WebMCP &amp; predictive UI</h1>
      <p className="lead">
        WebMCP is the right page-local transport for an agent to discover and call tools in the
        currently open site. Nifra adopts that standard directly and adds a complementary contract for
        the semantics WebMCP does not define: typed capabilities, deterministic prediction, versioned
        reconciliation, bounded receipts, and host-independent conformance tests.
      </p>

      <h2>One capability, one trust boundary</h2>
      <p>
        Define an explicit capability once. Its input and output schemas are the same Nifra core
        schemas used by every other adapter, and the handler still runs behind capability, approval,
        idempotency, budget, cancellation, and output checks.
      </p>
      <CodeBlock code={CAPABILITY} lang="ts" />

      <h2>Adopt WebMCP without a fork</h2>
      <p>
        Register only the tools your page intentionally offers. Nifra feature-detects
        <code>document.modelContext.registerTool</code>, isolates host registration failures, and
        makes unsupported browsers a no-op. Registration is discovery, not authorization: the server
        must enforce authorization again for writes.
      </p>
      <CodeBlock code={WEBMCP} lang="ts" />

      <h2>Keep remote MCP as the durable surface</h2>
      <p>
        WebMCP needs an open page and is local to that page. Remote MCP remains the right surface for
        background work, integrations, and MCP Apps. Project the same <code>capability.tool</code> into
        the existing MCP adapter; do not maintain a second schema or handler.
      </p>
      <CodeBlock code={MCP} lang="ts" />

      <h2>Predict, then reconcile</h2>
      <p>
        Predictive UI is application-owned deterministic state, not an LLM guess. A predictor returns a
        bounded <code>add</code>/<code>replace</code>/<code>remove</code> patch tied to an authoritative
        version. The store applies it atomically, and a successful server response either replaces the
        authoritative state or rolls the overlay back on failure, expiry, or conflict.
      </p>
      <CodeBlock code={PREDICTION} lang="ts" />

      <h2>What belongs in the complementary contract</h2>
      <p>
        Keep the browser standard small: discovery and execution. Keep Nifra’s public seam provider
        neutral: scope, bounded state paths, reconciliation policy, receipts, and deterministic
        conformance. Keep durable idempotency, tenancy, credentials, retention, pricing, and operated
        policy injected behind the same core contract. This makes the surface useful with any WebMCP
        host while preserving Nifra’s server-side trust boundary.
      </p>
    </div>
  )
}
