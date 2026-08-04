import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Choosing a TypeScript API framework in 2026 · Nifra",
  "What 'TypeScript framework' actually means - typed handlers vs inferred clients vs runtime validation - and how nifra, tRPC, Elysia, Hono, Fastify, and NestJS compare on each level, with measured throughput.",
  "/blog/typescript-api-framework",
)

export default function TypescriptApiFramework() {
  return (
    <article className="prose">
      <h1>Choosing a TypeScript API framework in 2026</h1>
      <p>
        <em>
          Updated 2026-08-04 · Disclosure: we build nifra, one of the options below. The
          framework-agnostic part - the three levels of "typed" - applies no matter what you pick.
        </em>
      </p>

      <p className="lead">
        Every framework claims TypeScript support. The claims mean three very different things, and
        knowing which level you are buying is the whole decision. Level 1: your handlers are typed.
        Level 2: your <em>client</em> is typed from the server. Level 3: the types are enforced at
        runtime too. Most production incidents blamed on "TypeScript didn't catch it" are a missing
        level, not a missing annotation.
      </p>

      <h2>The three levels of "typed"</h2>
      <ul>
        <li>
          <strong>Level 1 - typed handlers.</strong> Express with <code>@types/express</code>, Koa,
          most classic frameworks. The compiler checks your server code against itself. Nothing
          checks the caller.
        </li>
        <li>
          <strong>Level 2 - inferred contract.</strong> The client's request and response types
          derive from the server's types: tRPC, Elysia's Eden, Hono's <code>hc</code>, nifra's{" "}
          <code>client&lt;typeof app&gt;()</code>, ts-rest. A renamed field breaks the frontend
          build instead of production. The differentiators inside this level: does it need codegen
          (ts-rest and OpenAPI generators do; tRPC/Eden/hc/nifra don't), and does it survive
          non-TypeScript callers (tRPC's RPC shape doesn't map cleanly to plain HTTP; the others
          stay REST-shaped).
        </li>
        <li>
          <strong>Level 3 - runtime validation.</strong> Types are erased at runtime; a public
          endpoint typed <code>{`{ age: number }`}</code> still receives{" "}
          <code>{`{ age: "99; DROP TABLE" }`}</code> unless something checks. Fastify (JSON Schema),
          Elysia (TypeBox), NestJS (class-validator), and nifra (Standard Schema - Zod, Valibot,
          ArkType, or hand-rolled) validate declared schemas at the boundary. tRPC validates if you
          attach a schema per procedure; Hono via middleware. The question to ask: is validation the
          default path or a discipline?
        </li>
      </ul>

      <h2>The field, scored</h2>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            <th>Typed client</th>
            <th>Codegen needed</th>
            <th>Runtime validation</th>
            <th>Node req/s (our run, validated POST)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>nifra</td>
            <td>Inferred, REST-shaped</td>
            <td>No</td>
            <td>Default (Standard Schema)</td>
            <td>59,764</td>
          </tr>
          <tr>
            <td>Fastify</td>
            <td>No (add OpenAPI + generator)</td>
            <td>Yes, for a client</td>
            <td>Default (JSON Schema)</td>
            <td>53,442</td>
          </tr>
          <tr>
            <td>Elysia</td>
            <td>Inferred (Eden)</td>
            <td>No</td>
            <td>Default (TypeBox)</td>
            <td>44,130 (on Node; stronger on Bun)</td>
          </tr>
          <tr>
            <td>tRPC</td>
            <td>Inferred, RPC-shaped</td>
            <td>No</td>
            <td>Per-procedure schemas</td>
            <td>n/a (rides another server)</td>
          </tr>
          <tr>
            <td>Hono</td>
            <td>Inferred (hc)</td>
            <td>No</td>
            <td>Opt-in middleware</td>
            <td>32,332</td>
          </tr>
          <tr>
            <td>NestJS</td>
            <td>No (OpenAPI + generator)</td>
            <td>Yes, for a client</td>
            <td>Opt-in decorators</td>
            <td>(slowest of the set in public benchmarks)</td>
          </tr>
        </tbody>
      </table>
      <p>
        Throughput from our published harness (oha @ 50 conns, identical semantics; all rows +
        methodology on <a href="/benchmarks">benchmarks</a>). tRPC is a contract layer over an HTTP
        server rather than a server itself, so it has no row - pair its column with whichever host
        you'd run.
      </p>

      <h2>How to choose</h2>
      <ul>
        <li>
          <strong>Internal tools, TS on both ends, RPC feel is fine:</strong> tRPC remains
          excellent. Its weakness is the boundary with anything that isn't your TypeScript monorepo
          - mobile teams, partners, curl.
        </li>
        <li>
          <strong>Backend-only, maximum battle-testing:</strong> Fastify - accept the codegen step
          if you need a typed client.
        </li>
        <li>
          <strong>Bun-first backend:</strong> Elysia. <strong>Everything-runtimes minimal:</strong>{" "}
          Hono. (<a href="/blog/elysia-vs-hono">head-to-head</a>.)
        </li>
        <li>
          <strong>All three levels, REST-shaped, plus a frontend:</strong> nifra - the inferred
          client extends beyond fetch calls into SSR loaders, pages, and server functions for
          React/Vue/Svelte/Solid/Preact, validation is the default, and the API surface ships as a{" "}
          <a href="/blog/docs-as-mcp">live MCP server</a> so AI agents write against your real
          contract. Fastest of the set in our Node runs, and the same app moves to Bun for ~2x (
          <a href="/blog/bun-vs-node">measured</a>).
        </li>
      </ul>

      <h2>The test to run before committing</h2>
      <p>
        Whatever you shortlist: rename one response field on the server and see what breaks. If the
        answer is "nothing until runtime", you are at Level 1 with extra steps. Then POST a
        malformed body at a typed endpoint. If it reaches your handler, you are missing Level 3. Ten
        minutes, and it filters the field faster than any comparison table - including this one. (
        <code>bunx create-nifra my-app</code> if you want to run it on ours first.)
      </p>
    </article>
  )
}
