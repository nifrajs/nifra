import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra — Contract-derived adversarial testing",
  "Turn route schemas into hostile input, response-conformance, replay, shrinking, and runtime-matrix tests with @nifrajs/testing.",
)

const BASIC = `import { assertAdversarialContract } from "@nifrajs/testing"
import { app } from "../src/app"

const { test } = await import("bun:test")

test("the API contract withstands hostile inputs", async () => {
  await assertAdversarialContract(app, { seed: 73 })
})`

const WITNESS = `// Standard Schema guarantees validation, not introspection.
// Give opaque Zod/Valibot/ArkType routes only their known-good request values.
await assertAdversarialContract(app, {
  witnesses: {
    "POST /users/:id": {
      params: { id: "user-1" },
      body: { name: "Ada" },
      query: { notify: "true" },
    },
  },
})`

const AUTH = `await assertAdversarialContract(app, {
  prepareRequest(request, context) {
    const headers = new Headers(request.headers)
    headers.set("authorization", "Bearer test-session")
    headers.set("x-tenant-id", context.runtime === "worker" ? "edge-test" : "local-test")
    return new Request(request, { headers })
  },
})`

const MATRIX = `const report = await assertAdversarialContract(app, {
  runtimes: [
    { name: "bun",    fetch: (request) => bunApp.fetch(request) },
    { name: "node",   fetch: (request) => nodeAdapter.fetch(request) },
    { name: "worker", fetch: (request) => worker.fetch(request, env) },
  ],
})

// Each target receives the same case IDs and deterministic witnesses.
console.log(report.seed, report.counts)`

const REPLAY = `const report = await runAdversarialContract(app, { seed: 73 })
const failure = report.failures[0]

// CI can print this small, payload-free replay tuple.
console.error(failure.replay) // { seed: 73, caseId: "...", runtime: "worker" }

await assertAdversarialContract(app, {
  seed: failure.replay.seed,
  only: failure.replay.caseId,
})`

export default function ContractTesting() {
  return (
    <div className="prose">
      <h1 className="page">Contract-derived adversarial testing</h1>
      <p className="lead">
        A route contract should be more than documentation. <code>@nifrajs/testing</code> turns it
        into a laboratory: valid requests, hostile inputs, real boundary rejection, response
        conformance, shrinking, replay seeds, and adapter parity from one small test interface.
      </p>

      <h2>One assertion, every contracted boundary</h2>
      <CodeBlock code={BASIC} lang="ts" />
      <p>
        For every selected route, the laboratory synthesizes a valid <b>contract witness</b>. It then
        changes types, removes required fields, crosses numeric and length bounds, inserts unknown
        properties, and descends into nested objects and arrays. A mutation is sent only after the
        route&apos;s own Standard Schema validator proves it invalid. Query values are proved after URL
        serialization, exactly as the server receives them.
      </p>
      <p>
        Invalid inputs must produce 422 by default. A valid witness is also executed for every
        declared <code>response</code>, and the real JSON body is validated off the request hot path.
        Use <code>expectedValidationStatuses</code> or <code>isRejected</code> when your app deliberately
        has a different validation response.
      </p>

      <h2>Opaque schemas stay validator-neutral</h2>
      <p>
        Nifra&apos;s <code>t</code> schemas carry inspectable JSON Schema, so witness generation is
        automatic. Other Standard Schema libraries do not have to expose structure. Supply a known-good
        witness; their own validator still proves every hostile mutation.
      </p>
      <CodeBlock code={WITNESS} lang="ts" />
      <p>
        Missing, invalid, or unsynthesizable witnesses become explicit coverage gaps. The default is
        fail-closed; <code>requireCoverage: false</code> makes gaps advisory.
      </p>

      <h2>Auth and tenant context</h2>
      <p>
        <code>prepareRequest</code> runs for every case and runtime. Use it to attach a test session,
        tenant identity, signed headers, or platform bindings without putting secrets into reports.
      </p>
      <CodeBlock code={AUTH} lang="ts" />

      <h2>One contract, many runtimes</h2>
      <p>
        Supply fetch targets to exercise the identical cases through Bun, Node, Deno, or Workers
        adapters. Reflection still comes from the original app, so there is one authoritative contract.
      </p>
      <CodeBlock code={MATRIX} lang="ts" />

      <h2>Shrink and replay failures</h2>
      <p>
        Unexpectedly accepted hostile inputs are greedily reduced to a smaller validator-invalid
        request. Results do not print request bodies or headers; the stable case ID, runtime, and seed
        are enough to replay deterministically.
      </p>
      <CodeBlock code={REPLAY} lang="ts" />

      <blockquote>
        <p>
          The response-conformance pass executes handlers, including POST/DELETE handlers. Run it with
          isolated fixtures and a test database. Never point a contract laboratory at production.
        </p>
      </blockquote>
    </div>
  )
}
