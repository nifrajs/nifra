import { formatPercent, httpRealworldRps, httpWorkloadRps, percentOf } from "../../shared/data/benchmarks"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/comparison",
  "Nifra vs. other frameworks - the honest comparison",
  "How Nifra compares to the full-stack frameworks (Next.js, Nuxt, SvelteKit, Remix, TanStack Start) - and, as a standalone backend, to Hono and Elysia. Five UI frameworks, five runtimes, end-to-end types, and an agentic application layer built around typed capabilities.",
)

export default function Comparison() {
  return (
    <div className="prose">
      <h1 className="page">Nifra vs. other frameworks</h1>
      <p className="lead">
        Honest comparison. Nifra is a <b>full-stack framework first</b> - five UI libraries and five runtimes
        from one core, with loaders, actions, streaming, and a typed data layer - and a{" "}
        <b>standalone typed backend</b> you can use on its own. Here is where each tool fits.
      </p>

      <h2>Nifra's lane</h2>
      <p>
        Every other full-stack framework here is <b>one UI library on a mostly-one-runtime story</b>. Nifra
        bets the opposite axis: one core, many front-ends, many runtimes, with a contract-first typed backend
        in the same project.
      </p>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            <th>UI libraries</th>
            <th>Runtimes</th>
          </tr>
        </thead>
        <tbody>
          <tr className="hl">
            <td>Nifra</td>
            <td>React · Preact · Vue · Solid · Svelte</td>
            <td>Bun · Node · Deno · Workers · Edge</td>
          </tr>
          <tr>
            <td>Next.js</td>
            <td>React</td>
            <td>Node · Vercel Edge</td>
          </tr>
          <tr>
            <td>Nuxt 3</td>
            <td>Vue</td>
            <td>Nitro (many)</td>
          </tr>
          <tr>
            <td>SvelteKit</td>
            <td>Svelte</td>
            <td>adapters</td>
          </tr>
          <tr>
            <td>Remix / RR7</td>
            <td>React</td>
            <td>adapters</td>
          </tr>
          <tr>
            <td>TanStack Start</td>
            <td>React (Solid WIP)</td>
            <td>Nitro</td>
          </tr>
        </tbody>
      </table>

      <h2>Full-stack parity</h2>
      <p>Across the board, Nifra ships the modern full-stack feature set on all five UI frameworks:</p>
      <ul>
        <li>File routing (dynamic / catch-all / groups / optional) + nested layouts.</li>
        <li>
          SSR · SSG · ISR, streaming SSR with out-of-order Suspense, islands, view transitions, and a
          ~0&nbsp;KB-client vanilla adapter.
        </li>
        <li>
          Loaders + actions + <a href="/docs/server-functions">server functions</a> (typed{" "}
          <code>serverFn</code> RPC, server code never shipped to the browser) + progressive-enhancement
          forms; <code>defer()</code> / <code>&lt;Await&gt;</code> streaming data; query cache, optimistic
          UI, concurrent fetchers, revalidation.
        </li>
        <li>Head/meta, hover/focus prefetch, scroll restoration.</li>
        <li>
          First-party auth, i18n, image, uploads - plus content collections + MDX, font optimization, and
          draft / preview mode.
        </li>
      </ul>
      <p>
        The data model (loaders, actions, <code>defer</code>, progressive enhancement, fetchers,
        revalidation) is closest to <b>Remix / React Router</b> - delivered across five UI libraries instead
        of one.
      </p>

      <h2>Server code and server-only views</h2>
      <p>
        Nifra provides typed loaders and actions, streaming SSR, islands and typed{" "}
        <a href="/docs/server-functions">server functions</a>. Server functions keep their
        implementation, secrets and database handles off the browser and use the same validated
        mutation API across the supported UI libraries.
      </p>
      <p>
        The optional <a href="/docs/server-components">server-components pipeline</a> adds
        server-only views and state-preserving refresh. React uses native RSC/Flight; Vue, Svelte
        and Solid use their native islands in validated server-rendered ranges. The feature is
        intended for the release after 4.0.0 and requires all four adapters to pass certification.
        Server functions remain the mutation API; native React <code>"use server"</code> actions
        are unsupported.
      </p>

      <h2>Also a standalone backend (vs. Hono &amp; Elysia)</h2>
      <p>
        Nifra's core is a Bun-native, Web-standard server, so it stands on its own as an API - and graduates
        to full-stack later without a rewrite.
      </p>
      <ul>
        <li>
          <b>Throughput - the realistic case.</b> Router micro-benchmarks flatter Hono (a single compiled
          regex), but a real request also pays for middleware and validation,
          context, and serialization. In the current matrix Nifra runs <b>level with Elysia on Bun</b> -{" "}
          {formatPercent(
            percentOf(
              httpWorkloadRps("Bun", "Nifra", "getUsers"),
              httpWorkloadRps("Bun", "Elysia", "getUsers"),
            ),
          )} of Elysia on <code>GET /users/:id</code> and{" "}
          {formatPercent(
            percentOf(
              httpWorkloadRps("Bun", "Nifra", "postUsers"),
              httpWorkloadRps("Bun", "Elysia", "postUsers"),
            ),
          )} on the validated <code>POST</code> - and{" "}
          <b>level with Fastify on Node</b> ({formatPercent(
            percentOf(
              httpWorkloadRps("Node", "Nifra", "getUsers"),
              httpWorkloadRps("Node", "Fastify", "getUsers"),
            ),
          )} of Fastify on GET,{" "}
          {formatPercent(
            percentOf(
              httpWorkloadRps("Node", "Nifra", "postUsers"),
              httpWorkloadRps("Node", "Fastify", "postUsers"),
            ),
          )} on the validated <code>POST</code>), with Elysia, Hono,
          and Express behind. On <b>Deno</b> it runs at {formatPercent(
            percentOf(
              httpWorkloadRps("Deno", "Nifra", "getUsers"),
              httpWorkloadRps("Deno", "Elysia", "getUsers"),
            ),
          )} of Elysia on
          GET and {formatPercent(
            percentOf(
              httpWorkloadRps("Deno", "Nifra", "postUsers"),
              httpWorkloadRps("Deno", "Elysia", "postUsers"),
            ),
          )} on the validated <code>POST</code>. In the realistic shape (security headers + CORS +
          bearer auth + cookies + validated query/body + a ~2.4&nbsp;KB JSON response, measured with{" "}
          <code>oha</code>) Nifra runs at <b>{formatPercent(
            percentOf(
              httpRealworldRps("Bun", "Nifra", "get"),
              httpRealworldRps("Bun", "Elysia", "get"),
            ),
          )} of Elysia on GET and {formatPercent(
            percentOf(
              httpRealworldRps("Bun", "Nifra", "post"),
              httpRealworldRps("Bun", "Elysia", "post"),
            ),
          )} on POST</b>. Treat benchmark
          rows as same-run evidence, not a permanent law of nature.
        </li>
        <li>
          <b>End-to-end types.</b> <code>client&lt;typeof app&gt;()</code> derives request inputs <i>and</i>{" "}
          <code>res.data</code> from the route contracts - the compiler catches frontend/backend drift. Hono's{" "}
          <code>hc</code> and Elysia's Eden are typed too, but backend-only - no full-stack page/loader story.
        </li>
        <li>
          <b>Validation + OpenAPI.</b> Any Standard Schema plus <code>t</code> (TypeBox - free JSON Schema),
          emitting a real 3.1 doc with field-level request/response schemas (+ Scalar UI).
        </li>
        <li>
          <b>Batteries.</b> <code>@nifrajs/better-auth</code> + session guards, <code>@nifrajs/otel</code> (W3C{" "}
          <code>traceparent</code>, OTel semantic conventions), and <code>create-nifra</code> scaffolding
          (framework × deploy × CI × DB × auth, with an <code>AGENTS.md</code>).
        </li>
      </ul>
      <p className="caveat">
        <b>Run it yourself:</b> <code>bun run bench:realworld</code> and{" "}
        <code>bun run bench:http:compare</code>.
      </p>

      <h2>The AI-agent toolchain - Nifra-only</h2>
      <p>
        Nifra covers both sides of the agent loop: agents that edit your codebase and agents that are
        part of the product. Every surface is anchored to the same typed capability boundary:
      </p>
      <ul>
        <li>
          <code>nifra mcp</code> - an MCP server exposing <code>nifra_context</code> (the project's typed
          surface), <code>nifra_example</code> (snippets typechecked against the installed version - no
          hallucinated APIs), <code>nifra_scaffold</code> (URL → correct <code>routes/</code> file),{" "}
          <code>nifra_run</code> (verify via HTTP), and <code>nifra_check</code> (a drift gate that returns the
          fix). One MCP, two transports: the docs tools are also hosted at <code>mcp.nifra.dev</code>{" "}
          (no checkout needed), while the project tools run only on your machine - your code never
          leaves it.
        </li>
        <li>
          <code>llms.txt</code> + <code>llms-full.txt</code> served at the site root, an <code>AGENTS.md</code>{" "}
          in every scaffold, and a docs corpus that can't drift from the code.
        </li>
        <li>
          <code>nifra assure</code> + <code>nifra levels</code> - a route-assurance gate: a policy file
          classifies every reflected route and CI fails naming exactly which evidence is missing
          (authentication on writes, validation, declared effects). Spectral lints the OpenAPI{" "}
          <i>document</i> and Semgrep pattern-matches source text; neither sees the real route graph.
          This is what makes agent-written routes safe to merge - an agent (or a human) cannot ship an
          unauthenticated write past it.
        </li>
        <li>
          <code>@nifrajs/webmcp</code> - explicit page-local tools using the browser WebMCP standard,
          deterministic predictive UI, bounded receipts, and versioned reconciliation.{" "}
          <code>@nifrajs/ag-ui</code> streams the same run into a product UI, while{" "}
          <code>@nifrajs/agent-app</code> provides negotiated browser views, approvals, handoffs, and
          Run Studio projections.
        </li>
        <li>
          <code>@nifrajs/agent</code> - bounded typed agent turns with budgets, approvals, cancellation,
          resumable evidence, shared state, and provider-neutral model ports.{" "}
          <code>@nifrajs/a2a</code> exposes the same runner to other agents without rewriting the core.
        </li>
      </ul>

      <h2>Where Nifra fits</h2>
      <p>Reach for Nifra when you want:</p>
      <ul>
        <li>
          <b>One codebase, every front-end + runtime</b> - ship the same app on React, Vue, Solid,
          Svelte, or Preact, running on Bun, Node, Deno, and the edge, with no rewrite to switch either.
        </li>
        <li>
          <b>A type-locked stack</b> - the typed client derives requests and <code>res.data</code> from
          your route contracts, so the compiler catches any frontend/backend drift.
        </li>
        <li>
          <b>The full modern toolkit on your UI of choice</b> - loaders, actions, streaming SSR with
          out-of-order Suspense, SSG/ISR, islands, query cache, progressive-enhancement forms.
        </li>
        <li>
          <b>A framework AI agents edit accurately</b> - the <code>nifra mcp</code> toolchain + verified,
          version-checked examples, which no other framework ships.
        </li>
        <li>
          <b>To start lean and grow</b> - begin as a typed API, graduate to full-stack on the same core,
          no rewrite.
        </li>
      </ul>
      <p>
        Nifra provides streaming SSR, islands and typed{" "}
        <a href="/docs/server-functions">server functions</a>. The optional{" "}
        <a href="/docs/server-components">server-components pipeline</a> adds native React
        RSC/Flight and corresponding Vue, Svelte and Solid views under a shared execution contract.
      </p>
    </div>
  )
}
