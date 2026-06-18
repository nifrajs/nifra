import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra vs. other frameworks",
  "How Nifra compares to the full-stack frameworks (Next.js, Nuxt, SvelteKit, Remix, TanStack Start) — and, as a standalone backend, to Hono and Elysia. Five UI frameworks, five runtimes, end-to-end types, and an AI-agent toolchain no competitor ships.",
)

export default function Comparison() {
  return (
    <div className="prose">
      <h1 className="page">Nifra vs. other frameworks</h1>
      <p className="lead">
        Honest comparison. Nifra is a <b>full-stack framework first</b> — five UI libraries and five runtimes
        from one core, with loaders, actions, streaming, and a typed data layer — and a{" "}
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
          Loaders + actions + progressive-enhancement forms; <code>defer()</code> / <code>&lt;Await&gt;</code>{" "}
          streaming data; query cache, optimistic UI, concurrent fetchers, revalidation.
        </li>
        <li>Head/meta, hover/focus prefetch, scroll restoration.</li>
        <li>
          First-party auth, i18n, image, uploads — plus content collections + MDX, font optimization, and
          draft / preview mode.
        </li>
      </ul>
      <p>
        The data model (loaders, actions, <code>defer</code>, progressive enhancement, fetchers,
        revalidation) is closest to <b>Remix / React Router</b> — delivered across five UI libraries instead
        of one.
      </p>

      <h2>The line Nifra draws: no React Server Components</h2>
      <p>
        Nifra is classic <b>SSR + hydration</b> with streaming and islands — not RSC. No{" "}
        <code>"use server"</code> / <code>"use client"</code>, no server-only component tree. That is the one
        thing <b>Next.js App Router</b> has that Nifra doesn't, and it's deliberate: RSC is React-specific and
        would break a core that also serves Vue, Solid, and Svelte. (Nuxt, SvelteKit, and Remix don't ship RSC
        either — this is <i>Nifra vs. Next App Router specifically</i>.) Typed loaders, <code>defer()</code>,
        and route-level code-splitting cover the same problems by a different mechanism.
      </p>

      <h2>Also a standalone backend (vs. Hono &amp; Elysia)</h2>
      <p>
        Nifra's core is a Bun-native, Web-standard server, so it stands on its own as an API — and graduates
        to full-stack later without a rewrite.
      </p>
      <ul>
        <li>
          <b>Throughput — the realistic case.</b> Router micro-benchmarks flatter Hono (a single compiled
          regex), but a router is <b>~1% of a real request</b> — the time goes to middleware, validation,
          context, and serialization. In the bare Bun HTTP matrix, Nifra sits close to raw Bun and behind
          Elysia on most GET rows; in the current realistic preview (security headers + CORS + bearer auth +
          cookies + validated query/body + a ~3&nbsp;KB JSON response, measured with <code>oha</code>), it
          edges Elysia. Treat benchmark rows as same-run evidence, not a permanent law of nature.
        </li>
        <li>
          <b>End-to-end types.</b> <code>client&lt;typeof app&gt;()</code> derives request inputs <i>and</i>{" "}
          <code>res.data</code> from the route contracts — the compiler catches frontend/backend drift. Hono's{" "}
          <code>hc</code> and Elysia's Eden are typed too, but backend-only — no full-stack page/loader story.
        </li>
        <li>
          <b>Validation + OpenAPI.</b> Any Standard Schema plus <code>t</code> (TypeBox — free JSON Schema),
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

      <h2>The AI-agent toolchain — Nifra-only</h2>
      <p>
        No competitor — full-stack or backend — ships this. Every Nifra app is built to be edited by AI agents
        accurately:
      </p>
      <ul>
        <li>
          <code>nifra mcp</code> — an MCP server exposing <code>nifra_context</code> (the project's typed
          surface), <code>nifra_example</code> (snippets typechecked against the installed version — no
          hallucinated APIs), <code>nifra_scaffold</code> (URL → correct <code>routes/</code> file),{" "}
          <code>nifra_run</code> (verify via HTTP), and <code>nifra_check</code> (a drift gate that returns the
          fix).
        </li>
        <li>
          <code>llms.txt</code> + <code>llms-full.txt</code> served at the site root, an <code>AGENTS.md</code>{" "}
          in every scaffold, and a docs corpus that can't drift from the code.
        </li>
      </ul>

      <h2>Where Nifra fits</h2>
      <p>Reach for Nifra when you want:</p>
      <ul>
        <li>
          <b>One codebase, every front-end + runtime</b> — ship the same app on React, Vue, Solid,
          Svelte, or Preact, running on Bun, Node, Deno, and the edge, with no rewrite to switch either.
        </li>
        <li>
          <b>A type-locked stack</b> — the typed client derives requests and <code>res.data</code> from
          your route contracts, so the compiler catches any frontend/backend drift.
        </li>
        <li>
          <b>The full modern toolkit on your UI of choice</b> — loaders, actions, streaming SSR with
          out-of-order Suspense, SSG/ISR, islands, query cache, progressive-enhancement forms.
        </li>
        <li>
          <b>A framework AI agents edit accurately</b> — the <code>nifra mcp</code> toolchain + verified,
          version-checked examples, which no other framework ships.
        </li>
        <li>
          <b>To start lean and grow</b> — begin as a typed API, graduate to full-stack on the same core,
          no rewrite.
        </li>
      </ul>
      <p>
        The one deliberate trade: Nifra is streaming SSR + islands, <b>not</b> React Server Components —
        framework-agnostic by design. If your app is built specifically around RSC, that's the call
        you're making.
      </p>
    </div>
  )
}
