import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "The best Node.js frameworks in 2026",
  "An honest guide to Node.js web frameworks in 2026 - Fastify, Express, NestJS, Hono, and nifra - with published throughput numbers, typing stories, and a disclosed bias: we build nifra.",
)

export default function BestNodeFrameworks() {
  return (
    <article className="prose">
      <h1>The best Node.js frameworks in 2026</h1>
      <p>
        <em>
          Updated 2026-08-04 · Disclosure: we build nifra. Numbers below come from our published,
          reproducible benchmark; where a competitor wins a category we say so.
        </em>
      </p>

      <p className="lead">
        Node in 2026 is a mature platform with one incumbent per niche: <strong>Express</strong>{" "}
        (the default), <strong>Fastify</strong> (the fast one), <strong>NestJS</strong> (the
        enterprise structure), <strong>Hono</strong> (the portable minimalist), and{" "}
        <strong>nifra</strong> (the typed full-stack, ours). The right pick depends on what you are
        actually building.
      </p>

      <h2>Throughput, measured</h2>
      <p>
        From our published run (oha @ 50 conns, identical route semantics, raw{" "}
        <code>node:http</code> ceiling row included; harness in the repo):
      </p>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            <th>GET /users/:id</th>
            <th>POST /users (validated)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>nifra</td>
            <td>74,544 req/s</td>
            <td>59,764 req/s</td>
          </tr>
          <tr>
            <td>Fastify</td>
            <td>73,663 req/s</td>
            <td>53,442 req/s</td>
          </tr>
          <tr>
            <td>Elysia (on Node)</td>
            <td>67,525 req/s</td>
            <td>44,130 req/s</td>
          </tr>
          <tr>
            <td>Express</td>
            <td>44,176 req/s</td>
            <td>37,883 req/s</td>
          </tr>
          <tr>
            <td>Hono (on Node)</td>
            <td>42,227 req/s</td>
            <td>32,332 req/s</td>
          </tr>
        </tbody>
      </table>
      <p>
        Read it honestly: nifra and Fastify are the speed class - level on the GET (treat it as a
        tie), nifra ~12% ahead on the validated POST. Express costs you roughly 40% of your ceiling
        and nobody migrates off it for speed alone. Full tables:{" "}
        <a href="/benchmarks">benchmarks</a>.
      </p>

      <h2>Express - the default that refuses to die</h2>
      <p>
        Largest middleware ecosystem in existence, every tutorial assumes it, every hire knows it.
        It is also untyped at heart, slow relative to the field, and its middleware model predates
        async/await. Correct choice when team familiarity outweighs everything else; wrong choice
        for a new performance- or type-sensitive service.
      </p>

      <h2>Fastify - the Node speed benchmark</h2>
      <p>
        A decade of optimization, JSON-Schema validation compiled to fast validators, serious plugin
        encapsulation for large codebases. If you want a battle-tested, backend-only Node framework
        and don't need a frontend contract, Fastify remains excellent - our own benchmark treated it
        as the bar to clear. What it lacks: a built-in typed client (you add OpenAPI + codegen), any
        frontend story, and runtime portability.
      </p>

      <h2>NestJS - structure as a product</h2>
      <p>
        Angular-style modules, decorators, and DI for large teams that want enforced architecture.
        The trade is weight: slower than everything above it, a steep learning curve, and heavy
        abstraction over the HTTP layer. Choose it for organizational reasons, not technical ones.
      </p>

      <h2>Hono - portability first</h2>
      <p>
        One tiny API across every runtime. On Node specifically it gives up substantial throughput
        (see table) - its natural homes are Workers and small services where portability beats raw
        speed.
      </p>

      <h2>nifra - typed full-stack (ours)</h2>
      <p>
        nifra runs Fastify-class-or-better speed on Node while being a different kind of thing: a
        full-stack framework where <code>client&lt;typeof app&gt;()</code> infers the entire API
        contract with zero codegen, SSR serves React/Vue/Svelte/Solid/Preact, validation is the
        default at every boundary, and the docs/types ship as a{" "}
        <a href="/blog/docs-as-mcp">live MCP server</a> for AI coding agents. And because runtimes
        are adapters, the same app moves to Bun for roughly 2x the Node throughput -{" "}
        <a href="/blog/bun-vs-node">measured, same code</a> - or to Deno and edge workers. Honest
        caveat: youngest ecosystem on this page; first-party batteries instead of a decade of
        third-party plugins.
      </p>

      <h2>Pick in one minute</h2>
      <ul>
        <li>
          Team knows it, speed irrelevant → <strong>Express</strong>
        </li>
        <li>
          Backend-only, battle-tested, Node forever → <strong>Fastify</strong>
        </li>
        <li>
          Big org wants enforced structure → <strong>NestJS</strong>
        </li>
        <li>
          Same code on Workers/everywhere → <strong>Hono</strong>
        </li>
        <li>
          Typed full-stack, fastest in our matrix, agent-native → <strong>nifra</strong> (
          <code>bunx create-nifra my-app</code>)
        </li>
      </ul>
      <p>
        Head-to-head: <a href="/compare/fastify">nifra vs Fastify</a> ·{" "}
        <a href="/compare/hono">nifra vs Hono</a>.
      </p>
    </article>
  )
}
