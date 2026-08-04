import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Contract-derived adversarial testing",
  "Turn route schemas into hostile input, response-conformance, replay, shrinking, and runtime-matrix tests with @nifrajs/testing.",
  "/docs/testing",
)

const VALIDATE_RESPONSES = `import { testClient } from "@nifrajs/client"
import { app } from "./app"

// Every JSON response is checked against the route's declared schema for its status:
// \`response\` for 2xx, \`errors[status]\` for declared failures. A mismatch THROWS.
const api = testClient<typeof app>(app, { validateResponses: true })

const res = await api.me.get()   // ResponseContractViolation if the payload drifted`

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

const MOCK = `import { createMockServer } from "@nifrajs/mock"
import { app } from "./app.ts"

// Reads the routes' \`response\` schemas and generates data matching their shape.
// The seed is fixed, so a snapshot taken today still matches tomorrow.
const mock = createMockServer(app, { seed: 42 })

const res = await mock.fetch(new Request("http://local/notes"))`

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

      <h2>Assert the server keeps its own contract</h2>
      <p>
        A route&rsquo;s <code>response</code> schema types the handler and the client, but nothing
        re-checks the bytes that actually leave the app. <code>validateResponses</code> closes that gap
        in tests: every JSON response is validated against the schema declared for its status, and a
        mismatch throws <code>ResponseContractViolation</code> straight through the
        otherwise-never-throwing client - because a drifted payload passing quietly is the failure
        this exists to prevent.
      </p>
      <CodeBlock code={VALIDATE_RESPONSES} lang="ts" />
      <p>
        Whether it catches <em>undeclared extra</em> fields depends on your validator, not on nifra: a
        strict schema (<code>@nifrajs/schema</code>&rsquo;s <code>t.object</code>) reports them and the
        test fails, while a stripping one (Zod, Valibot) accepts them silently. To catch extras
        regardless, or to stop them reaching the wire in production, use{" "}
        <a href="/docs/security">
          <code>responseContract</code>
        </a>
        .
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

      <h2>A mock server from the same contract</h2>
      <p>
        <code>@nifrajs/mock</code> builds a fake backend out of the routes you already have. It reads
        each route's <code>response</code> schema and generates data of that shape, so the mock cannot
        drift from the contract the way a hand-written fixture file does - a changed schema changes the
        mock, and a route with no response schema returns <code>{}</code> rather than something
        invented.
      </p>
      <CodeBlock code={MOCK} lang="ts" />
      <p>
        Useful for building a frontend against a backend that is not finished, and for demos that must
        not touch a real database. It generates SHAPE, not meaning: the values are plausible-looking
        filler, so it answers "does this render" rather than "is this right".
      </p>

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
