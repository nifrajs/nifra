import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Execution causality",
  "Carry one bounded, payload-free lineage across the durable seams a trace cannot span: commands, events, workflows, projections, and repairs.",
)

const START = `import { createMemoryCausalityStore, startCausality } from "@nifrajs/core/causality"

const recorder = createMemoryCausalityStore()
const requestId = crypto.randomUUID()

// One root node at the ingress boundary. executionId is the graph's identity:
// generate it once, then propagate it.
const step = startCausality("request", requestId, { executionId: crypto.randomUUID() })

// step.context propagates; step.record is what a durable adapter appends.
await recorder.record(step.record)`

const CONTINUE = `import { continueCausality, startCausality } from "@nifrajs/core/causality"

const step = startCausality("request", crypto.randomUUID(), {
  executionId: crypto.randomUUID(),
})

// The command this request caused. The edge relation is a bounded token.
const command = continueCausality(step.context, "command", crypto.randomUUID(), {
  relation: "caused",
})

// The event that command emitted, inside the same commit.
const event = continueCausality(command.context, "event", crypto.randomUUID(), {
  relation: "emitted",
})`

const HEADERS = `import {
  causalityHeaders,
  readCausalityHeaders,
  startCausality,
} from "@nifrajs/core/causality"

const step = startCausality("request", crypto.randomUUID(), {
  executionId: crypto.randomUUID(),
})

// Outbound: bounded headers only.
await fetch("https://billing.internal/charge", {
  headers: causalityHeaders(step.context),
})

// Inbound: never throws on hostile input.
const request = new Request("https://api.example/charge")
const parsed = readCausalityHeaders(request.headers)
if (!parsed.success) {
  // "missing" | "incomplete" | "invalid" | "unknown-field" - start a fresh graph.
}`

export default function Causality() {
  return (
    <div className="prose">
      <h1 className="page">Execution causality</h1>
      <p className="lead">
        A trace describes one observation tree. Causality survives the seams a trace cannot: a command
        commits an event, a workflow resumes tomorrow, a projection consumes that event, and
        reconciliation repairs the drift. Same execution, four identities that used to stop at the
        boundary.
      </p>

      <h2>Tokens only, by construction</h2>
      <p>
        A causality record has <strong>no payload field</strong>. There is nowhere to put a request
        body, a tenant identifier, or a URL, and unknown fields are rejected at every nesting level
        rather than carried along. Identities are bounded tokens, edge relations are bounded tokens,
        and the lineage stays safe to store and read during an incident.
      </p>

      <h2>Start at the boundary</h2>
      <CodeBlock code={START} lang="ts" />

      <h2>Continue across seams</h2>
      <CodeBlock code={CONTINUE} lang="ts" />
      <p>
        <code>joinCausality</code> merges several parents into one node, and refuses to join contexts
        from different executions: a graph that silently spanned two requests would be worse than no
        graph.
      </p>

      <h2>Propagation is a trust boundary</h2>
      <CodeBlock code={HEADERS} lang="ts" />
      <p>
        Inbound headers are <strong>untrusted by default</strong>. A caller does not get to attach
        their request to your graph unless you say so, so a service-to-service seam opts in explicitly
        and anything that fails the check starts a fresh execution instead of being believed.
      </p>

      <h2>Storage is yours</h2>
      <p>
        <code>createMemoryCausalityStore()</code> is for development and tests. It is bounded, and it
        refuses to construct under <code>NODE_ENV=production</code>: in-memory evidence disappears on
        restart, which is exactly when an incident timeline matters. Production supplies a durable
        adapter behind the same <code>CausalityRecorder</code> interface, ideally appending in the same
        transaction as the effect it describes.
      </p>

      <h2>Traces still apply</h2>
      <p>
        The two models compose. <code>@nifrajs/otel</code> turns the nearest observed ancestor into a
        span link, so an event consumed tomorrow links back to the request that emitted it rather than
        inventing a trace identity that never existed.
      </p>
    </div>
  )
}
