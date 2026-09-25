import { formatRatio, formatRps, httpWorkloadRps } from "../../data/benchmarks"
import { postMeta } from "../../meta"

export const hydrate = false

export const meta = postMeta(
  "fastify-vs-express",
  "Fastify vs Express in 2026: measured, not vibes · Nifra",
  "Fastify vs Express compared with current benchmark results - throughput, validation, typing, ecosystem - plus when neither is the right answer. Includes our disclosed bias: we build Nifra.",
)

function httpValue(framework: string, workload: "getUsers" | "postUsers"): string {
  return formatRps(httpWorkloadRps("Node", framework, workload))
}

export default function FastifyVsExpress() {
  return (
    <article className="prose">
      <h1>Fastify vs Express in 2026</h1>
      <p>
        <em>
          Updated 2026-08-04 · Disclosure: we build <a href="/">Nifra</a>, a third option measured
          in the same runs. The Fastify-vs-Express verdict below stands on its own.
        </em>
      </p>

      <p className="lead">
        The eternal Node question, answered with measurements instead of vibes: Fastify has higher
        measured throughput than Express in our current published run, has real validation built in,
        and its plugin system is better engineered. Express still wins on ubiquity. Details, then
        the verdict.
      </p>

      <h2>Throughput</h2>
      <table>
        <thead>
          <tr>
            <th>Workload</th>
            <th>Express</th>
            <th>Fastify</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>GET /users/:id</td>
            <td>{httpValue("Express", "getUsers")} req/s</td>
            <td>{httpValue("Fastify", "getUsers")} req/s</td>
          </tr>
          <tr>
            <td>POST /users (validated)</td>
            <td>{httpValue("Express", "postUsers")} req/s</td>
            <td>{httpValue("Fastify", "postUsers")} req/s</td>
          </tr>
        </tbody>
      </table>
      <p>
        (oha @ 50 conns, Node 26.10.0, identical route semantics; Express validates with its usual
        middleware, Fastify with compiled JSON Schema. Full methodology + every framework we
        measure: <a href="/benchmarks">benchmarks</a>.) A raw <code>node:http</code> baseline does
        measured 48,376 GET req/s in the same runs.
      </p>

      <h2>Beyond speed</h2>
      <ul>
        <li>
          <strong>Validation:</strong> Fastify ships JSON-Schema validation compiled to fast
          functions; Express leaves it to middleware you assemble. This is the biggest practical gap
          - unvalidated input on a public endpoint is how incidents start.
        </li>
        <li>
          <strong>TypeScript:</strong> both are typed via <code>@types</code>; Fastify's generics
          and type providers go further. Neither gives you a typed client for your frontend.
        </li>
        <li>
          <strong>Ecosystem:</strong> Express has the largest middleware library ever assembled and
          every tutorial ever written. Fastify's plugin encapsulation is better engineered for large
          codebases. Express wins breadth; Fastify wins architecture.
        </li>
        <li>
          <strong>Maintenance:</strong> both are actively maintained in 2026; Express 5 finally
          landed but changed little structurally.
        </li>
      </ul>

      <h2>Verdict</h2>
      <p>
        New backend-only Node service: <strong>Fastify</strong>, and it isn't close - you get higher
        measured throughput and validation as a first-class citizen. Existing Express app that
        works: keep it; migrations rarely pay for themselves on speed alone.
      </p>

      <h2>When neither is the answer</h2>
      <p>
        Both are backend-only. If the API and a frontend are one product, a typed contract that
        crosses that boundary saves more engineering time than any req/s number: Nifra infers the
        entire client from the server's TypeScript type (zero codegen), serves SSR for five UI
        frameworks, validates by default, and in the same benchmark runs level-to-ahead of Fastify
        on Node (<a href="/compare/fastify">the honest head-to-head</a>) while the same app delivers
        about{" "}
        {formatRatio(
          httpWorkloadRps("Bun", "Nifra", "getUsers"),
          httpWorkloadRps("Node", "Nifra", "getUsers"),
        )}{" "}
        as many GET /users/:id requests per second on Bun as Node (
        <a href="/blog/bun-vs-node">measured on the same code</a>). Different category, same speed
        class - worth knowing it exists before defaulting.
      </p>
    </article>
  )
}
