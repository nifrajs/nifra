import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra vs Hono - typed full-stack vs run-anywhere router",
  "Nifra vs Hono compared honestly: what router micro-benchmarks hide, measured throughput with realistic middleware, typed clients, and when Hono's run-anywhere minimalism is exactly right.",
)

export default function VsHono() {
  return (
    <article className="prose">
      <h1>Nifra vs Hono</h1>
      <p className="lead">
        Hono is the ubiquitous minimal router: small, fast, runs on every JavaScript runtime, and
        deservedly everywhere. Nifra plays a different game - a full-stack framework with an
        end-to-end typed contract - while matching the run-anywhere property. Here is where each one
        earns its place.
      </p>

      <h2>What router micro-benchmarks hide</h2>
      <p>
        Bare router benchmarks flatter minimal frameworks: a single compiled match against a handler
        that returns a constant. Real services validate bodies, stack middleware, and serialize real
        payloads. Our published benchmark measures that shape - identical workloads per framework,
        including a schema-validated <code>POST</code> and a realistic middleware stack (security
        headers + CORS + request-id). In that shape nifra tops the measured framework field on Bun,
        Deno, and Node alike - on Node that includes Fastify, with Hono, Elysia, and Express behind.
        Every number is reproducible from the repo - the <a href="/benchmarks">benchmarks page</a>{" "}
        publishes the losses too.
      </p>

      <h2>Both run everywhere. Differently.</h2>
      <p>
        Hono's portability is its core identity: one small router API across Node, Bun, Deno,
        Cloudflare Workers, and more. Nifra ships the same property as runtime adapters - Bun, Node,
        Deno, edge workers - but carries the whole application across: routes, validation, SSR,
        server functions, the typed client. With Hono, the router is portable and the rest of the
        stack is your assembly; with nifra, the stack is the framework.
      </p>

      <h2>Typed clients: hc vs inferred contract</h2>
      <p>
        Hono's <code>hc</code> client is genuinely good - typed RPC from your route types. Nifra's
        client works the same way at the API layer, then extends the contract into the frontend:
        loaders, pages, and server functions share the same inferred types, so a server-side schema
        change breaks the frontend build instead of production. If you only need typed API access,
        both deliver; if the API and the UI are one product, one contract beats two projects.
      </p>

      <h2>Head to head</h2>
      <table>
        <thead>
          <tr>
            <th />
            <th>Nifra</th>
            <th>Hono</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Scope</td>
            <td>Full-stack framework</td>
            <td>Minimal router + middleware</td>
          </tr>
          <tr>
            <td>Validation</td>
            <td>Standard Schema, enforced at the boundary</td>
            <td>Via validator middleware, opt-in</td>
          </tr>
          <tr>
            <td>Frontend</td>
            <td>SSR/ISR for React, Vue, Svelte, Solid, Preact</td>
            <td>JSX middleware (server-rendered snippets)</td>
          </tr>
          <tr>
            <td>Throughput (realistic shape)</td>
            <td>Ahead on Bun/Deno/Node in our published runs</td>
            <td>Fast; strongest in bare-router shapes</td>
          </tr>
          <tr>
            <td>Ecosystem</td>
            <td>Young, first-party batteries (jobs, cache, storage, auth)</td>
            <td>Huge - the safest middleware bet in JS</td>
          </tr>
          <tr>
            <td>AI-agent tooling</td>
            <td>Live MCP docs server + structured verification</td>
            <td>llms.txt docs</td>
          </tr>
        </tbody>
      </table>

      <h2>When to pick which</h2>
      <ul>
        <li>
          <strong>Pick nifra</strong> when the API and frontend are one product, when you want
          validation and typing to be the default rather than a discipline, or when AI agents write
          a meaningful share of the code and need docs and verification built for them - see{" "}
          <a href="/blog/docs-as-mcp">the agent-native thesis</a>.
        </li>
        <li>
          <strong>Hono fits</strong> a small service or worker where a minimal router is the whole
          job and its middleware ecosystem or an exotic deploy target is the requirement.
        </li>
      </ul>
      <p>
        Full capability breakdown: <a href="/docs/comparison">the comparison doc</a>. Scaffold:{" "}
        <code>bunx create-nifra my-app</code>.
      </p>
    </article>
  )
}
