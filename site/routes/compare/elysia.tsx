import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra vs Elysia - Bun frameworks compared",
  "Nifra vs Elysia compared honestly: measured throughput on identical workloads (level to ahead on Bun, ahead on Deno), typed clients, and the difference between a backend framework and a full-stack one.",
)

export default function VsElysia() {
  return (
    <article className="prose">
      <h1>Nifra vs Elysia</h1>
      <p className="lead">
        Elysia is the best-known Bun-first backend framework, and it set the bar nifra measures
        itself against. The short version: on identical benchmarked workloads nifra is level to
        ahead of Elysia on Bun and ahead on Deno, and the larger difference is scope - Elysia is a
        backend framework, nifra is a full-stack one.
      </p>

      <h2>Throughput, on identical workloads</h2>
      <p>
        Both frameworks are fast enough that the interesting question is overhead relative to the
        raw runtime. In our published two-workload benchmark (a path-param <code>GET</code> and a
        schema-validated <code>POST</code>, identical semantics per framework, load driven by{" "}
        <code>oha</code>):
      </p>
      <ul>
        <li>
          On <strong>Bun</strong>, nifra runs level with Elysia on <code>GET /users/:id</code> at
          101% of a hand-rolled <code>Bun.serve</code> baseline - the framework layer costs nothing
          measurable - and 105% of Elysia on the validated <code>POST</code>.
        </li>
        <li>
          In the <strong>realistic middleware shape</strong> (security headers + CORS + request-id
          on every request), nifra runs at 103% of Elysia on GET and 108% on POST.
        </li>
        <li>
          On <strong>Deno</strong>, nifra leads every measured framework, Elysia included, on both
          workloads.
        </li>
      </ul>
      <p>
        Single-digit percentages, honestly labeled: treat them as "the same speed class, with the
        edge to nifra as middleware stacks up". The harness and methodology are public - the{" "}
        <a href="/benchmarks">benchmarks page</a> has every row, including the ones nifra loses.
      </p>

      <h2>Typed clients: Eden vs inferred</h2>
      <p>
        Both frameworks solve typed API access. Elysia's Eden gives you a typed treaty client from
        your server type; nifra's client infers request and response types from route declarations
        the same way. The difference is what sits above it: nifra's typed contract extends through
        loaders, pages, and server functions, because the frontend is part of the framework rather
        than a separate project consuming the API.
      </p>

      <h2>Backend framework vs full-stack framework</h2>
      <table>
        <thead>
          <tr>
            <th />
            <th>Nifra</th>
            <th>Elysia</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>HTTP + validation + typed client</td>
            <td>Yes</td>
            <td>Yes</td>
          </tr>
          <tr>
            <td>SSR + file-based frontend routing</td>
            <td>Yes - React, Vue, Svelte, Solid, Preact</td>
            <td>No (bring your own frontend)</td>
          </tr>
          <tr>
            <td>Server functions, ISR, islands</td>
            <td>Yes</td>
            <td>No</td>
          </tr>
          <tr>
            <td>Runtimes</td>
            <td>Bun, Node, Deno, edge workers</td>
            <td>Bun-first, adapters for others</td>
          </tr>
          <tr>
            <td>Verification tooling</td>
            <td>
              <code>nifra check</code> / <code>assure</code> / <code>doctor</code>, structured
              output
            </td>
            <td>Type-level guarantees</td>
          </tr>
          <tr>
            <td>Docs for AI agents</td>
            <td>Live MCP server + typed corpus, CI-gated freshness</td>
            <td>llms.txt style docs</td>
          </tr>
        </tbody>
      </table>
      <p>
        Where Elysia is strong: a mature plugin ecosystem, a large community, and years of Bun-first
        production use. If you want a backend-only framework and you are all-in on Bun, Elysia is a
        genuinely good choice - this page exists because people ask, not because the alternative is
        bad.
      </p>

      <h2>When to pick which</h2>
      <ul>
        <li>
          <strong>Pick Elysia</strong> if you want a Bun backend with a plugin ecosystem and you
          have a separate frontend story you are happy with.
        </li>
        <li>
          <strong>Pick nifra</strong> if you want the backend and frontend in one typed contract,
          the option to change UI framework or runtime later, and tooling built for AI-assisted
          development - at the same or better throughput.
        </li>
      </ul>
      <p>
        Start with <code>bunx create-nifra my-app</code> (backend) or <code>--template site</code>{" "}
        (full-stack). Deeper capability comparison:{" "}
        <a href="/docs/comparison">the comparison doc</a>.
      </p>
    </article>
  )
}
