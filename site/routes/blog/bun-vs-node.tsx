import { HTTP_WORKLOADS } from "../../data/benchmarks"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Bun vs Node.js in 2026: same app, both runtimes, measured · Nifra",
  "Bun vs Node.js compared with a control most benchmarks lack: the identical application, same framework, same routes, benchmarked on both runtimes. Where Bun's ~2x holds, where it shrinks, and when Node is still the right call.",
  "/blog/bun-vs-node",
)

function httpValue(runtime: string, name: string, workload: "getUsers" | "postUsers"): string {
  return (
    HTTP_WORKLOADS.find((table) => table.title === runtime)?.rows.find(
      (row) => row.name === name,
    )?.[workload] ?? "n/a"
  )
}

export default function BunVsNode() {
  return (
    <article className="prose">
      <h1>Bun vs Node.js in 2026: same app, both runtimes</h1>
      <p>
        <em>
          Updated 2026-08-04 · We build <a href="/">Nifra</a>, a framework that runs unchanged on
          both runtimes - which is exactly what makes this comparison clean.
        </em>
      </p>

      <p className="lead">
        Most Bun-vs-Node comparisons benchmark different frameworks on each runtime and call it a
        runtime difference. Ours holds the application constant: the same Nifra app, same routes,
        same validation, benchmarked on both. That isolates what the runtime is actually worth.
      </p>

      <h2>The numbers</h2>
      <table>
        <thead>
          <tr>
            <th>Workload (identical app)</th>
            <th>Node 26</th>
            <th>Bun 1.3</th>
            <th>Bun advantage</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>GET /users/:id</td>
            <td>{httpValue("Node", "Nifra", "getUsers")} req/s</td>
            <td>{httpValue("Bun", "Nifra", "getUsers")} req/s</td>
            <td>~1.8x</td>
          </tr>
          <tr>
            <td>POST /users (validated)</td>
            <td>{httpValue("Node", "Nifra", "postUsers")} req/s</td>
            <td>{httpValue("Bun", "Nifra", "postUsers")} req/s</td>
            <td>~1.6x</td>
          </tr>
          <tr>
            <td>SSR (React page, per request)</td>
            <td>27,186 req/s</td>
            <td>33,217 req/s</td>
            <td>~1.2x</td>
          </tr>
        </tbody>
      </table>
      <p>
        (oha @ 50 conns, medians, harness public - <a href="/benchmarks">all rows here</a>.) The
        pattern is the honest headline: Bun's advantage is largest on raw HTTP work (~1.6-1.8x), and
        shrinks as your own JavaScript dominates the request (~1.2x on SSR, and near-zero on a
        DB-bound endpoint where the runtime waits on Postgres either way).
      </p>

      <h2>What Bun actually buys you</h2>
      <ul>
        <li>HTTP serving at roughly double Node's throughput for cheap endpoints</li>
        <li>One toolchain: runtime + package manager + test runner + bundler</li>
        <li>Startup fast enough to change how dev loops and serverless cold starts feel</li>
      </ul>

      <h2>What Node still holds</h2>
      <ul>
        <li>A decade+ of production hardening, observability tooling, and ops knowledge</li>
        <li>Perfect ecosystem compatibility - the long tail of npm just works</li>
        <li>Organizational reality: your platform team already runs it</li>
      </ul>

      <h2>The part people miss: it doesn't have to be a decision</h2>
      <p>
        The runtime only locks you in if your framework does. A Nifra app treats the runtime as an
        adapter: develop and deploy on Node today, move the identical code to Bun when the
        throughput matters (or Deno, or edge workers). The numbers above are that story measured -
        nobody rewrote anything between the two columns. On Node, Nifra runs level-to-ahead of
        Fastify (<a href="/compare/fastify">details</a>); on Bun it serves at 101% of a hand-rolled{" "}
        <code>Bun.serve</code> baseline - so you are not paying a framework tax on either side.
      </p>

      <h2>Verdict</h2>
      <p>
        New project, no organizational constraint: start on Bun - the throughput and toolchain are
        real. Existing Node estate: stay until an endpoint is CPU-bound on request handling, then
        move that service. Either way, pick application code that is portable between them -{" "}
        <code>bunx create-nifra my-app</code> is one way to get that for free.
      </p>
    </article>
  )
}
