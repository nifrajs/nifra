import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "The best Bun frameworks in 2026",
  "An honest guide to Bun web frameworks in 2026 - Elysia, Hono, and nifra compared on speed, typing, scope, and ecosystem, with published benchmarks and a clear disclosure: we build one of them.",
)

export default function BestBunFrameworks() {
  return (
    <article className="prose">
      <h1>The best Bun frameworks in 2026</h1>
      <p>
        <em>
          Updated 2026-08-04 · Disclosure: we build nifra. Every claim below links to reproducible
          numbers or the framework's own docs, and we say plainly where the others win.
        </em>
      </p>

      <p className="lead">
        Bun made server-side JavaScript fast by default; the framework question is what you put on
        top. Three serious options dominate in 2026: <strong>Elysia</strong> (the Bun-first backend
        framework), <strong>Hono</strong> (the run-anywhere minimal router), and{" "}
        <strong>nifra</strong> (the full-stack, agent-native one - ours). Here is how to choose.
      </p>

      <h2>The short version</h2>
      <table>
        <thead>
          <tr>
            <th />
            <th>Scope</th>
            <th>Typed client</th>
            <th>Throughput (our published run)</th>
            <th>Pick it when</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>nifra</td>
            <td>Full-stack: API + SSR for React/Vue/Svelte/Solid/Preact</td>
            <td>Inferred from server, zero codegen, reaches loaders/pages</td>
            <td>101% of a raw Bun.serve baseline on GET; 105% of Elysia on validated POST</td>
            <td>API + frontend are one product; AI agents write real code</td>
          </tr>
          <tr>
            <td>Elysia</td>
            <td>Backend framework</td>
            <td>Eden treaty, typed end-to-end (backend only)</td>
            <td>Level with nifra on GET; behind on validated POST</td>
            <td>Backend-only on Bun with a mature plugin ecosystem</td>
          </tr>
          <tr>
            <td>Hono</td>
            <td>Minimal router + middleware</td>
            <td>hc RPC client, typed (backend only)</td>
            <td>Behind both in our matrix; strongest in bare-router shapes</td>
            <td>Small services, exotic deploy targets, maximum portability</td>
          </tr>
        </tbody>
      </table>
      <p>
        Throughput numbers are from our published two-workload matrix (oha, identical route
        semantics per framework, raw-runtime ceiling rows included) - the{" "}
        <a href="/benchmarks">benchmarks page</a> carries every row and the harness is in the repo.
        Treat single-digit margins as ties; the structural differences below matter more.
      </p>

      <h2>Elysia - the Bun-first backend standard</h2>
      <p>
        Elysia earned its place: ergonomic API, TypeBox validation compiled fast, the Eden typed
        client, and the largest Bun-specific plugin ecosystem. If your frontend lives in a separate
        repo with its own framework and you want the best-known Bun backend, Elysia is a genuinely
        good choice and the ecosystem bet is safe. Its limits are scope ones: no SSR story, no
        frontend contract - Eden's types stop at the API boundary.
      </p>

      <h2>Hono - the portability king</h2>
      <p>
        Hono runs on everything - Bun, Node, Deno, Cloudflare Workers, Lambda - with one tiny API,
        and its middleware ecosystem is the largest in the class. On Bun specifically it gives up
        measurable throughput to Elysia and nifra in our runs, and like Elysia it is backend-only.
        Choose it when "runs literally anywhere" is the requirement or the service is small enough
        that a router is the whole job.
      </p>

      <h2>nifra - full-stack and agent-native (ours)</h2>
      <p>
        nifra's bet is different: the API and the frontend are one typed contract.{" "}
        <code>client&lt;typeof app&gt;()</code> infers every path, param, body, and response from
        the server type - zero codegen - and the same contract extends through SSR loaders, pages,
        and server functions for React, Vue, Svelte, Solid, or Preact. The docs, examples, and exact
        API types ship as a <a href="/blog/docs-as-mcp">live MCP server</a> so AI assistants write
        against the current release, and <code>nifra check</code>/<code>assure</code> return
        structured output agents act on. Same app runs on Node, Deno, and edge workers unchanged.
        The honest caveat: it is the youngest of the three, and its first-party batteries (jobs,
        cache, storage, auth) trade ecosystem breadth for coherence.
      </p>

      <h2>How to decide in one minute</h2>
      <ul>
        <li>
          Backend only, Bun only, want plugins → <strong>Elysia</strong>
        </li>
        <li>
          Tiny service or exotic runtime target → <strong>Hono</strong>
        </li>
        <li>
          Full-stack product, typed end-to-end, AI-assisted development → <strong>nifra</strong> (
          <code>bunx create-nifra my-app</code>)
        </li>
      </ul>
      <p>
        Deeper head-to-heads: <a href="/compare/elysia">nifra vs Elysia</a> ·{" "}
        <a href="/compare/hono">nifra vs Hono</a> · full tables on{" "}
        <a href="/benchmarks">benchmarks</a>.
      </p>
    </article>
  )
}
