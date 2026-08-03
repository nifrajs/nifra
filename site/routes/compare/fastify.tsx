import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra vs Fastify - Node's speed king vs a typed full-stack",
  "Nifra vs Fastify compared honestly: ahead on Node in our published benchmark (~12% on the validated POST, level on GET), what each gives you beyond raw throughput, and why the same nifra app runs unchanged - and much faster - on Bun.",
)

export default function VsFastify() {
  return (
    <article className="prose">
      <h1>Nifra vs Fastify</h1>
      <p className="lead">
        Fastify is the Node.js performance benchmark for a reason: a decade of optimization, a
        serious plugin architecture, and honest engineering culture. Nifra respects it enough to
        publish the numbers plainly: in our current benchmark nifra runs ahead of Fastify on Node -
        clearly on the validated write, within noise on the read. The real comparison is what you
        get at that speed - and what happens when you leave Node.
      </p>

      <h2>The Node numbers</h2>
      <p>
        On identical workloads, nifra leads the framework field on Node. On the schema-validated{" "}
        <code>POST</code> it runs ~12% ahead of Fastify, at 96% of a raw <code>node:http</code>{" "}
        baseline - validation included. On the path-param <code>GET</code> the two are level,
        trading places run to run; treat that one as a tie. Behind them: Elysia, Express, Hono.
        Every row, the methodology, and the harness itself are public on the{" "}
        <a href="/benchmarks">benchmarks page</a> - rerun it and check us.
      </p>

      <h2>The part Fastify cannot do: leave Node</h2>
      <p>
        A nifra app is runtime-portable: the identical code deploys to Node, Bun, Deno, or edge
        workers through adapters. The same benchmarked app on Bun serves several times the Node
        throughput, at 101% of a hand-rolled <code>Bun.serve</code> baseline - the framework layer
        measurably costs nothing there. If your Node service is CPU-bound on request handling, the
        cheapest optimization may be a runtime switch that changes zero lines of application code.
      </p>

      <h2>Beyond throughput</h2>
      <table>
        <thead>
          <tr>
            <th />
            <th>Nifra</th>
            <th>Fastify</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Validation</td>
            <td>Standard Schema (Zod, Valibot, ArkType, or hand-rolled), typed into handlers</td>
            <td>JSON Schema, compiled fast, typing via provider packages</td>
          </tr>
          <tr>
            <td>Typed client</td>
            <td>Inferred from the server, zero codegen</td>
            <td>Not built in (OpenAPI + generator, or hand-written)</td>
          </tr>
          <tr>
            <td>Frontend story</td>
            <td>SSR/ISR for five UI frameworks, server functions, typed loaders</td>
            <td>None - API framework by design</td>
          </tr>
          <tr>
            <td>Plugins</td>
            <td>First-party batteries: jobs, cache, storage, auth, i18n, MCP</td>
            <td>Deep third-party ecosystem, encapsulation model</td>
          </tr>
          <tr>
            <td>Runtimes</td>
            <td>Node, Bun, Deno, edge workers</td>
            <td>Node</td>
          </tr>
          <tr>
            <td>AI-agent tooling</td>
            <td>Live MCP docs server, structured verification commands</td>
            <td>Standard docs</td>
          </tr>
        </tbody>
      </table>

      <h2>Where Fastify is the right choice</h2>
      <p>
        A Node-committed organization with existing Fastify plugins, operational knowledge, and no
        frontend coupling has little reason to migrate over a benchmark. Fastify's plugin
        encapsulation is excellent for large modular codebases, its JSON Schema validation is
        battle-tested, and its decade of production miles is not something a young framework can
        claim. If that is your shape, stay - and benchmark us again next year.
      </p>

      <h2>Where nifra wins</h2>
      <p>
        Choose nifra when you want Fastify-class speed <em>plus</em> a typed contract that reaches
        the frontend, runtime portability as insurance, validation that is the default rather than a
        setup step, and a framework whose docs and verification loop are built for the AI agents
        writing an increasing share of the code. Capability-by-capability detail:{" "}
        <a href="/docs/comparison">the comparison doc</a>.
      </p>
    </article>
  )
}
