import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page - no React interactivity, so ship zero framework JS.
export const hydrate = false

export const meta = pageMeta(
  "Nifra - Effect provenance",
  "A route declares the effects it performs, and `nifra check` fails it for being able to reach further than it declared. How reach is computed, why that shapes your modules, and how the declaration turns into an enforced policy.",
)

const POLICY = `import { server } from "@nifrajs/core/server"
import { defineAssuranceConfig, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"

const app = server()

export default defineAssuranceConfig({
  source: app,
  capabilities: {
    definitions: [
      { id: "db.read", zone: "domain", access: "read" },
      { id: "db.write", zone: "domain", access: "write" },
    ],
    provenance: {
      // Reaching one of these implies holding the capabilities beside it.
      imports: [
        { specifier: "./read.ts", capabilities: ["db.read"] },
        { specifier: "./write.ts", capabilities: ["db.write"] },
        { specifier: "bun:sqlite", capabilities: ["db.read", "db.write"] },
      ],
      forbiddenImports: [],
    },
  },
  policy: {
    rules: [
      // Not a list of token names: anything whose DEFINITION is a domain write.
      {
        name: "authenticated-write",
        match: { access: "write", zone: "domain" },
        require: [NIFRA_ASSURANCE.AUTHENTICATED],
      },
      { name: "read", match: { methods: ["GET"] }, require: [] },
    ],
  },
})`

const UNDECLARED = `$ nifra check

✗ effect/capability assurance: 1
    POST /notes evidence exceeds its declaration: db.write`

const DECLARED = `$ nifra check
✓ effect/capability assurance: none

$ nifra assure
✖ POST /notes (authenticated-write) is missing nifra.authenticated`

const UNCONFINED = `$ nifra check

✗ effect/capability assurance: 1
    GET / can reach domain write capability db.write without declaring it, and a safe method
    may not declare one - move the route or the effect so the write is not in its module's reach`

const ROOT = `// src/app.ts - composition only. It merges route modules and registers none of its own.
import { server } from "@nifrajs/core/server"
import { routes } from "./routes.ts"

export const app = server().merge(routes)`

const SEAM = `db/
  index.ts        the connection - no route module imports this
  read.ts         reads, mapped to db.read
  write.ts        writes, mapped to db.write
  read-routes.ts  GET routes; imports ./read.ts only, so it can declare db.read and nothing more
  write-routes.ts POST routes; imports ./write.ts only`

const BEACON = `import { useCapability } from "@nifrajs/core/capabilities"
import { createCache } from "@nifrajs/cache"

const cache = createCache({ beacon: useCapability })

// Announces cache.write against THIS route before the operation, and throws if it was not declared.
export const write = async (c: object): Promise<void> => {
  await cache.for(c).set("k", 1)
}`

const LEVELS = `$ nifra capabilities snapshot   # writes capabilities.lock.json
$ nifra levels
✓ L0 typed contract
✓ L1 route assurance
✓ L2 capability lockfile`

export default function Capabilities() {
  return (
    <div className="prose">
      <h1 className="page">Effect provenance</h1>
      <p className="lead">
        A route declares the effects it performs. Nifra works out what it can actually reach, and fails
        the check when the two disagree. That turns "this endpoint touches the database" from a comment
        into something CI enforces - and it is what lets a policy say "anything that writes must prove
        who asked" and have that be true.
      </p>

      <h2>The declaration</h2>
      <p>
        A route says what it does with <code>capabilities</code>, the same on a hand-written route or a
        server function:
      </p>
      <CodeBlock
        code={`.post("/notes", { body: NoteInput, capabilities: ["db.write"] }, handler)`}
        lang="ts"
      />
      <p>
        On its own that is an assertion. What makes it load-bearing is the other half:{" "}
        <code>provenance.imports</code> maps a module specifier to the capabilities that reaching it
        implies, so nifra can compare what a route <em>says</em> against what it <em>can do</em>.
      </p>
      <CodeBlock code={POLICY} lang="ts" />
      <p>
        Every <code>create-nifra</code> template ships this, armed. You do not have to write it to get
        the guarantee.
      </p>

      <h2>The chain, end to end</h2>
      <p>Write to the database and declare nothing, and the check says so:</p>
      <CodeBlock code={UNDECLARED} lang="bash" />
      <p>Declare it, and the policy takes over:</p>
      <CodeBlock code={DECLARED} lang="bash" />
      <p>
        Only an authenticated write ships. Nobody had to remember anything - and note that the rule
        matches on <code>access</code> and <code>zone</code> rather than naming <code>db.write</code>,
        so a token introduced next year is covered the day it is declared instead of the day someone
        remembers to widen the rule.
      </p>

      <h2>Reach is per module</h2>
      <p>
        This is the rule everything else follows from, so it is worth stating plainly:{" "}
        <strong>
          a route's reach is computed from the module that REGISTERS it, following that module's
          imports, transitively.
        </strong>
      </p>
      <p>
        Not from the handler body - static analysis cannot honestly tell you which closure touched
        which import. From the module. So a file that registers routes <em>and</em> imports a database
        gives every route in it database reach, whether or not it uses it. That is conservative, and it
        is true: the handler really does have the connection in lexical scope.
      </p>
      <p>Which produces a specific dead end, and a specific finding for it:</p>
      <CodeBlock code={UNCONFINED} lang="bash" />
      <p>
        A GET route may not declare a domain write - that is an HTTP semantics rule. So a GET in a
        module that can reach a write has no declaration that is both legal and true, and no amount of
        editing the declaration fixes it. The fix is structural, and the message says so rather than
        bouncing you between two impossible demands.
      </p>

      <h2>What that means for your modules</h2>
      <p>Two habits follow, and the templates are shaped around both.</p>
      <p>
        <strong>The app root composes; it does not register.</strong> If the root both merges route
        modules and declares routes of its own, those routes inherit the reach of everything merged
        there.
      </p>
      <CodeBlock code={ROOT} lang="ts" />
      <p>
        <strong>A feature is a module,</strong> owning its store, its adapters and the routes over
        them. The second feature with a database of its own gets its own file rather than another
        section of this one.
      </p>

      <h2>Splitting the seam by access</h2>
      <p>
        A raw driver cannot tell a read from a write at the import, so it grants both - which means a
        GET route in any module that can reach the driver is stuck. Putting your queries behind a seam
        split by access is what unsticks it, and it is what <code>create-nifra --db</code> scaffolds:
      </p>
      <CodeBlock code={SEAM} lang="text" />
      <p>
        Because <code>./read.ts</code> is mapped in <code>provenance.imports</code>, the walk stops
        there and grants exactly <code>db.read</code> - it never reaches the driver underneath. Keep
        the two halves import-disjoint, at the seam and at the route modules, and every route's
        declaration equals its reach.
      </p>

      <h2>Runtime beacons</h2>
      <p>
        Static provenance answers what a <em>module</em> can reach, so its evidence is as broad as the
        module. A beacon answers which <em>route</em> did what, at the moment it does it.{" "}
        <code>@nifrajs/cache</code>, <code>@nifrajs/jobs</code> and <code>@nifrajs/storage</code> can
        emit one:
      </p>
      <CodeBlock code={BEACON} lang="ts" />
      <p>
        <code>useCapability</code> is passed in rather than imported by those packages, so all three
        keep their zero dependencies - a cache should not pull the server into a bundle that only
        wanted a cache. Nothing changes for existing code: only the <code>for(context)</code> path
        announces anything, and asking for it without a configured beacon throws rather than handing
        back something that silently proves nothing.
      </p>
      <p>
        The two are complements. Static provenance is total and runs in CI; a beacon is exact but only
        speaks for code that actually executed.
      </p>

      <h2>The lockfile</h2>
      <p>
        Once assurance passes, snapshot the result. The lockfile is a review artifact: a route that
        starts touching something new shows up as a diff in the pull request rather than as nothing at
        all.
      </p>
      <CodeBlock code={LEVELS} lang="bash" />
      <p>
        That is L2 on <a href="/docs/verification">the verification ladder</a>. See also{" "}
        <a href="/docs/server-functions">server functions</a>, which are public POST endpoints and are
        covered by exactly the same policy.
      </p>

      <h2>Turning it down</h2>
      <p>
        The firewall is <code>provenance.imports</code> in <code>nifra.assurance.ts</code>, and it is
        yours. Emptying it disarms the reach comparison while leaving the declarations and the policy
        in place; removing a driver entry stops that driver implying anything. Nothing here is
        load-bearing for the framework - it is load-bearing for the guarantee, and the guarantee is
        opt-out.
      </p>
    </div>
  )
}
