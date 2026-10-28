import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/security-testing",
  "Nifra - Security testing",
  "Security invariants, mutation testing, adversarial inputs, and runtime differential checks in Nifra.",
)

const COMMANDS = `# Validate every invariant has executable evidence
bun run check:security-invariants

# Run the fast changed-line mutation report
bun scripts/mutate.ts --changed --gate

# Run a selected security target locally
bun scripts/mutate.ts --target core-capabilities --gate

# Exercise hostile requests across supported runtimes
bun run check:runtime-differential`

export default function SecurityTesting() {
  return (
    <div className="prose">
      <h1 className="page">Security testing</h1>
      <p className="lead">
        Nifra treats security claims as executable invariants. A rule is useful only when a hostile
        input, a deliberate mutation, or a recovery fault would make a test fail if the protection
        disappeared.
      </p>

      <h2>One invariant, several kinds of evidence</h2>
      <p>
        <code>security-invariants.json</code> is the index for the repository&apos;s security claims. Each
        entry names the behavior, regression tests, mutation targets, and documentation that explain
        it. <code>bun run check:security-invariants</code> fails when a referenced test or target is
        removed, so the index cannot silently become a list of aspirations.
      </p>
      <p>
        The ledger is intentionally separate from an application&apos;s secrets and tenant data. Add a
        reduced public regression fixture for a real finding; keep private application details in the
        private test suite.
      </p>

      <h2>Mutation testing</h2>
      <p>
        Mutation testing changes one condition, operator, return value, or statement at a time. A
        security target passes only when its tests kill every meaningful mutant. A surviving mutant
        needs a regression test or an explicit equivalence explanation in
        <code>mutation-equivalents.json</code>; adding a survivor to a baseline is a temporary record,
        not proof of safety.
      </p>
      <CodeBlock code={COMMANDS} lang="sh" />

      <h2>What to test at a security boundary</h2>
      <ul>
        <li>
          <strong>Authorization:</strong> denial happens before the handler, database write, or side
          effect; ownership is checked for the requested resource.
        </li>
        <li>
          <strong>Replay and recovery:</strong> repeated idempotency keys do not repeat effects, and an
          uncertain commit becomes an explicit reconciliation state.
        </li>
        <li>
          <strong>Input limits:</strong> raw and multipart bodies stop at their read budget, malformed
          encodings are rejected, and prototype-pollution keys cannot alter output objects.
        </li>
        <li>
          <strong>Data boundaries:</strong> response projection strips fields, errors redact provider
          details, and server-only imports cannot reach browser chunks.
        </li>
        <li>
          <strong>Runtime parity:</strong> Bun, Node, Deno, and Workers agree on rejection status,
          headers, redaction, and side-effect behavior for the same hostile request.
        </li>
      </ul>

      <h2>Adding a new edge case</h2>
      <p>
        Start with the smallest reproduction that proves the failure. Give it a stable diagnostic or
        test name, add the fixed behavior to the relevant invariant, add a mutation that would remove
        the guard when practical, and document the trigger, consequence, fix, and verification
        command. This keeps the docs, CLI, MCP, and test suite growing from evidence.
      </p>
    </div>
  )
}
