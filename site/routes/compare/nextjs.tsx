import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra vs Next.js - a faster, typed, multi-runtime alternative",
  "Nifra vs Next.js compared honestly: server rendering throughput (25x in reproducible benchmarks), end-to-end types without codegen, five UI frameworks instead of one, and where Next.js is still the right choice.",
  "/compare/nextjs",
)

export default function VsNextjs() {
  return (
    <article className="prose">
      <h1>Nifra vs Next.js</h1>
      <p className="lead">
        Next.js is the default full-stack React framework. Nifra is a full-stack TypeScript
        framework where React is one of five supported UI frameworks, the backend contract is typed
        end-to-end without codegen, and the same app runs on Bun, Node, Deno, or edge workers. Here
        is the honest comparison, including where Next.js wins.
      </p>

      <h2>The headline differences</h2>
      <table>
        <thead>
          <tr>
            <th />
            <th>Nifra</th>
            <th>Next.js</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>UI framework</td>
            <td>React, Vue, Svelte, Solid, or Preact</td>
            <td>React only</td>
          </tr>
          <tr>
            <td>Server rendering</td>
            <td>25x throughput in our published benchmark</td>
            <td>Baseline (see methodology below)</td>
          </tr>
          <tr>
            <td>API layer</td>
            <td>Typed routes with schema validation; client types inferred, zero codegen</td>
            <td>Route handlers / server actions; typing is your responsibility</td>
          </tr>
          <tr>
            <td>Runtimes</td>
            <td>Bun, Node, Deno, edge workers - one app, adapter per runtime</td>
            <td>Node (Vercel-optimized), partial edge support</td>
          </tr>
          <tr>
            <td>React Server Components</td>
            <td>No - deliberate (see below)</td>
            <td>Yes, the App Router is built on them</td>
          </tr>
          <tr>
            <td>AI-agent tooling</td>
            <td>Docs/types as a live MCP server; structured verification commands</td>
            <td>llms.txt style docs</td>
          </tr>
        </tbody>
      </table>

      <h2>The 25x number, honestly</h2>
      <p>
        In our reproducible SSR benchmark - the same dynamic page, server-rendered by each
        framework's production build on its default runtime - Nifra with React serves roughly 25x
        the requests per second of Next.js. The harness lives in the Nifra repo, publishes its
        methodology, and includes rows Nifra does not win. That gap is not React being slow: it is
        the cost of the meta-framework layer around the render. Full tables and per-framework
        results are on the <a href="/benchmarks">benchmarks page</a>.
      </p>

      <h2>Where Next.js is the right choice</h2>
      <p>
        Nifra does not implement React Server Components, and that is a deliberate line: RSC is a
        React-only architecture, and a framework core that five UI frameworks share cannot be built
        on it. If your application is architected around RSC itself - streaming component payloads,
        server-only component trees as the organizing idea -{" "}
        <strong>Next.js App Router is the right tool</strong>, and Nifra will not pretend otherwise.
        Next.js also brings the largest React ecosystem, years of production hardening at every
        scale, and first-party Vercel integration.
      </p>

      <h2>Where Nifra wins</h2>
      <ul>
        <li>
          <strong>End-to-end types without codegen.</strong> The client infers request and response
          types directly from the server's route declarations. Rename a field on the server and the
          frontend fails to compile - no generated client, no drift.
        </li>
        <li>
          <strong>Framework choice.</strong> The same routing, SSR, and server-function machinery
          serves React, Vue, Svelte, Solid, and Preact. Migrating UI frameworks stops being a
          rewrite of your backend.
        </li>
        <li>
          <strong>Runtime portability.</strong> Deploy the identical app to Bun, Node, Deno, or edge
          workers by swapping an adapter import.
        </li>
        <li>
          <strong>Built for AI agents.</strong> Documentation, runnable examples, and exact API
          types ship as a live MCP server, and verification commands (<code>nifra check</code>,{" "}
          <code>nifra assure</code>) return structured output an agent can act on. See{" "}
          <a href="/blog/docs-as-mcp">why docs should be an MCP server</a>.
        </li>
        <li>
          <strong>Speed as a floor, not a feature.</strong> SSR, ISR, and raw HTTP throughput are
          benchmarked continuously against the field, and the numbers are reproducible from a clean
          clone.
        </li>
      </ul>

      <h2>Try the migration path</h2>
      <p>
        <code>bunx create-nifra my-app --template site --framework react</code> scaffolds the
        full-stack shape: file-based routes, typed loaders, server functions, and a typed client.
        The <a href="/docs/migrate-frontend">migration guide</a> covers moving an existing app; the
        full capability-by-capability breakdown is in{" "}
        <a href="/docs/comparison">the comparison doc</a>.
      </p>
    </article>
  )
}
