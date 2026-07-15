import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Verification ladder",
  "Five cumulative levels, from a typed contract to contract-derived invariant tests, that say what a Nifra project actually proves.",
)

const LEVELS = `# What does this project prove right now?
nifra levels

# Fail CI below a level the project already reached.
nifra levels --min 2

# The same report an agent reads over MCP (nifra_levels).
nifra levels --json`

const OUTPUT = `L0  typed contract        ok
L1  route assurance       ok
L2  capability lockfile   ok
L3  route manifest        FAIL  manifest drifted from routes: run \`nifra manifest emit\`
L4  invariant-tested      FAIL  no isolated invariant executor configured

achieved: 2`

const CONFIG = `// nifra.assurance.ts
// doc-check: skip - policy rules and the isolated executor are app-specific
import { defineAssuranceConfig } from "@nifrajs/core/assurance"
import { backend } from "./backend"

export default defineAssuranceConfig({
  source: backend,
  policy: { rules: [/* ... */] },
  capabilities: { lockfile: "capabilities.lock.json", policy: { /* ... */ } },
  manifest: { path: "nifra.manifest.json" },
  invariants: {
    // L4 fuzzes the contract, so it needs an app you are willing to throw hostile
    // input at. Point this at an isolated instance, never a live one.
    executor: (request) => backend.fetch(request),
  },
})`

export default function Verification() {
  return (
    <div className="prose">
      <h1 className="page">Verification ladder</h1>
      <p className="lead">
        "It compiles" and "it is secure" are different claims. The ladder makes the difference
        legible: five levels, each earned, so a project can state what it proves instead of what it
        hopes.
      </p>

      <h2>The five levels</h2>
      <p>
        Levels are <strong>cumulative</strong>. A level only counts when every level below it holds,
        so <code>achieved</code> is the highest rung with unbroken support underneath, and it is{" "}
        <code>-1</code> when even L0 fails.
      </p>
      <ul>
        <li>
          <strong>L0 typed contract</strong> - <code>nifra check</code> passes: the frontend and
          backend cannot have silently diverged.
        </li>
        <li>
          <strong>L1 route assurance</strong> - every route is classified, and the enforcement a rule
          requires is actually installed.
        </li>
        <li>
          <strong>L2 capability lockfile</strong> - declared effects match a reviewed lockfile, so a
          route that starts writing to the database shows up in review.
        </li>
        <li>
          <strong>L3 route manifest</strong> - the committed trust artifact still matches the routes,
          evidence, effects, and response classification it was emitted from.
        </li>
        <li>
          <strong>L4 invariant-tested</strong> - contract-derived invariants ran against an isolated
          executor with nothing skipped.
        </li>
      </ul>

      <h2>Run it</h2>
      <CodeBlock code={LEVELS} lang="sh" />
      <CodeBlock code={OUTPUT} lang="text" />
      <p>
        Every level that does not hold explains itself, so the output is a work list rather than a
        verdict. <code>--min &lt;n&gt;</code> is the CI floor: pin it to the level you have reached and
        the build fails when a change quietly costs you a rung.
      </p>

      <h2>Wiring the levels</h2>
      <p>
        L0 needs nothing. L1 through L4 hang off <code>nifra.assurance.ts</code>, and each one you
        configure is a level you can start claiming.
      </p>
      <CodeBlock code={CONFIG} lang="ts" />
      <p>
        L4 requires an <strong>explicit</strong> executor. Invariant runs send deliberately hostile
        input, so nifra will not guess which app to point them at; a level that fuzzed your live
        server by default would be a footgun, and a skipped route is reported rather than passed over
        in silence.
      </p>

      <h2>For coding agents</h2>
      <p>
        The <code>nifra_levels</code> MCP tool returns the same{" "}
        <code>{"{ achieved, levels[] }"}</code> report. An agent can read what its change proved, and a
        level that regressed comes back with the reason it broke.
      </p>
    </div>
  )
}
