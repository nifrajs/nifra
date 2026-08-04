import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Elysia vs Hono in 2026: which Bun framework fits · Nifra",
  "Elysia vs Hono compared honestly - throughput on identical workloads, typed clients (Eden vs hc), validation, portability - with measured numbers and a disclosed bias: we build nifra, a third option.",
  "/blog/elysia-vs-hono",
)

export default function ElysiaVsHono() {
  return (
    <article className="prose">
      <h1>Elysia vs Hono in 2026</h1>
      <p>
        <em>
          Updated 2026-08-04 · Disclosure: we build <a href="/">nifra</a> and measure all three in
          one harness. The Elysia-vs-Hono verdict below is straight from the data.
        </em>
      </p>

      <p className="lead">
        Both are excellent TypeScript backend frameworks with typed clients; they optimize for
        different things. Elysia optimizes for Bun - deepest integration, fastest numbers on it.
        Hono optimizes for portability - one small API on every runtime that exists. That single
        difference decides most projects.
      </p>

      <h2>Throughput, same workloads</h2>
      <table>
        <thead>
          <tr>
            <th>Runtime · workload</th>
            <th>Elysia</th>
            <th>Hono</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Bun · GET /users/:id</td>
            <td>130,219 req/s</td>
            <td>97,628 req/s</td>
          </tr>
          <tr>
            <td>Bun · POST (validated)</td>
            <td>93,818 req/s</td>
            <td>74,616 req/s</td>
          </tr>
          <tr>
            <td>Node · GET /users/:id</td>
            <td>67,525 req/s</td>
            <td>42,227 req/s</td>
          </tr>
          <tr>
            <td>Deno · both workloads</td>
            <td colSpan={2}>Elysia ahead in our runs</td>
          </tr>
        </tbody>
      </table>
      <p>
        (oha @ 50 conns, identical route semantics, medians; every row incl. ceilings on{" "}
        <a href="/benchmarks">benchmarks</a>.) On raw speed Elysia wins everywhere we measure -
        Hono's design trades peak throughput for reach.
      </p>

      <h2>The real differences</h2>
      <ul>
        <li>
          <strong>Typed client:</strong> Elysia's Eden and Hono's <code>hc</code> both derive a
          typed RPC client from server types. Eden is deeper (treaty model); hc is simpler. Wash for
          most apps.
        </li>
        <li>
          <strong>Validation:</strong> Elysia bakes in TypeBox, compiled fast, ergonomic. Hono
          validates via middleware (Zod etc.) - fine, but opt-in.
        </li>
        <li>
          <strong>Portability:</strong> Hono's entire identity - Workers, Lambda, Deno, Bun, Node,
          one API. Elysia runs beyond Bun via adapters but loses its edge there (see Node row).
        </li>
        <li>
          <strong>Ecosystem:</strong> Hono's middleware collection is broader; Elysia's plugins go
          deeper on Bun specifics.
        </li>
      </ul>

      <h2>Verdict</h2>
      <p>
        Deploy target is Bun and you want maximum backend speed with ergonomic validation:{" "}
        <strong>Elysia</strong>. Deploy target is Cloudflare Workers, Lambda, or "we might move":{" "}
        <strong>Hono</strong>. Neither is a wrong answer; picking against your deploy target is.
      </p>

      <h2>The third option</h2>
      <p>
        Both stop at the API boundary. If you also own the frontend, nifra extends the typed
        contract through SSR loaders, pages, and server functions (React/Vue/Svelte/Solid/Preact),
        matches or beats Elysia's throughput in our published Bun runs (101% of the raw{" "}
        <code>Bun.serve</code> ceiling on GET, 105% of Elysia on validated POST), runs on all the
        same runtimes, and ships its docs as a <a href="/blog/docs-as-mcp">live MCP server</a> for
        AI coding agents. Head-to-heads: <a href="/compare/elysia">vs Elysia</a> ·{" "}
        <a href="/compare/hono">vs Hono</a>.
      </p>
    </article>
  )
}
