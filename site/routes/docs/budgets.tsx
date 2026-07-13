import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra — Request budgets",
  "Propagate one absolute deadline through Nifra requests and downstream adapters without resetting time at each hop.",
)

const SERVER = `import { server } from "@nifrajs/core"

const app = server({
  requestTimeoutMs: 2_000,
  acceptInboundDeadlines: true,
  maxInboundDeadlineMs: 5_000,
}).get("/report", async (c) => {
  // c.signal aborts at the SAME effective deadline.
  // remaining() is monotonic even if the wall clock jumps.
  return { remainingMs: c.budget.remaining() }
})`

const FORWARD = `// doc-check: skip — context and downstream adapter are established by the app
const child = c.budget.child(50) // keep 50ms to serialize the response

await fetch(url, {
  signal: child.signal,
  headers: withDeadlineHeader(undefined, child),
})`

export default function RequestBudgets() {
  return (
    <div className="prose">
      <h1 className="page">Request budgets</h1>
      <p className="lead">
        A timeout should not restart at every hop. Nifra admits one absolute wire deadline, clamps it
        to local policy, and exposes monotonic remaining time beside the existing cancellation signal.
      </p>

      <h2>Clamp once at admission</h2>
      <CodeBlock code={SERVER} lang="ts" />
      <p>
        The canonical header is <code>x-nifra-deadline</code>, containing Unix epoch milliseconds.
        Admission is an explicit trust-boundary choice via <code>acceptInboundDeadlines</code>; ordinary
        public routes ignore the header by default. Once enabled, a client value can only shorten
        local work. Malformed values return 400, expired values return 408, and a request that exhausts
        an inherited deadline returns 504.
      </p>

      <h2>Reserve time for the caller</h2>
      <CodeBlock code={FORWARD} lang="ts" />
      <p>
        <code>child(reserveMs)</code> preserves response cleanup time without resetting the absolute
        deadline. Downstream adapters must also use <code>remaining()</code> for their actual timeout;
        forwarding the header alone is decorative.
      </p>

      <blockquote>
        <p>
          Configure a finite <code>requestTimeoutMs</code> before handing <code>c.budget</code> to a
          production adapter. The no-timeout compatibility path is deliberately unbounded and is not
          written to the wire.
        </p>
      </blockquote>
    </div>
  )
}
