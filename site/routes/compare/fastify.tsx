import {
  formatPercent,
  formatRatio,
  formatRps,
  httpWorkloadRps,
  runtimeCeilingPercent,
} from "../../data/benchmarks"
import { compareMeta } from "../../meta"

export const hydrate = false

export const meta = compareMeta(
  "fastify",
  "Nifra vs Fastify",
  "Nifra vs Fastify - Node's speed king vs a typed full-stack",
  "Nifra vs Fastify compared honestly: current Node benchmark results, what each gives you beyond raw throughput, and why the same Nifra app runs unchanged across runtimes.",
)

export default function VsFastify() {
  return (
    <article className="prose">
      <h1>Nifra vs Fastify</h1>
      <p className="lead">
        Fastify is the Node.js performance benchmark for a reason: a decade of optimization, a
        serious plugin architecture, and honest engineering culture. Nifra respects it enough to
        publish the numbers plainly: in our current benchmark Nifra runs ahead of Fastify on Node -
        clearly on the validated write and path-param read. The real comparison is what you get at
        that speed - and what happens when you leave Node.
      </p>

      <h2>The Node numbers</h2>
      <p>
        On identical workloads, Nifra leads the framework field on Node. On the schema-validated{" "}
        <code>POST</code>, Nifra records {formatRps(httpWorkloadRps("Node", "Nifra", "postUsers"))}{" "}
        req/s, Fastify records {formatRps(httpWorkloadRps("Node", "Fastify", "postUsers"))} req/s,
        and raw <code>node:http</code> records{" "}
        {formatRps(httpWorkloadRps("Node", "node-raw", "postUsers"))} req/s. On the path-param{" "}
        <code>GET</code>, the same source reports Nifra at{" "}
        {formatRps(httpWorkloadRps("Node", "Nifra", "getUsers"))} req/s and Fastify at{" "}
        {formatRps(httpWorkloadRps("Node", "Fastify", "getUsers"))} req/s. Behind them: Elysia,
        Express, Hono. Every row, the methodology, and the harness itself are public on the{" "}
        <a href="/benchmarks">benchmarks page</a> - rerun it and check us.
      </p>

      <h2>The part Fastify cannot do: leave Node</h2>
      <p>
        A Nifra app is runtime-portable: the identical code deploys to Node, Bun, Deno, or edge
        workers through adapters. The same benchmarked app records{" "}
        {formatRatio(
          httpWorkloadRps("Bun", "Nifra", "getUsers"),
          httpWorkloadRps("Node", "Nifra", "getUsers"),
        )}{" "}
        as much throughput on Bun as on Node, at {formatPercent(runtimeCeilingPercent("Bun"))} of a
        hand-rolled <code>Bun.serve</code> baseline on the published GET - the framework layer
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

      <h2>When to pick which</h2>
      <ul>
        <li>
          <strong>Pick Nifra</strong> for the speed lead <em>plus</em> everything above it: a typed
          contract that reaches the frontend, runtime portability as insurance, validation as the
          default rather than a setup step, and docs + verification built for the AI agents writing
          an increasing share of the code.
        </li>
        <li>
          <strong>Staying on Fastify is reasonable</strong> for a Node-committed team with deep
          plugin investment and no frontend coupling - a benchmark alone is not a migration reason,
          and its decade of production miles is real. Benchmark us again next year.
        </li>
      </ul>
      <p>
        Capability-by-capability detail: <a href="/docs/comparison">the comparison doc</a>.
        Scaffold: <code>bun create nifra my-app</code>.
      </p>
    </article>
  )
}
