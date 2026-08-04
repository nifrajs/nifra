import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Next.js alternatives in 2026 - what to use and when · Nifra",
  "An honest guide to Next.js alternatives in 2026: Remix, SvelteKit, Nuxt, SolidStart, Astro, and nifra - who each is for, measured SSR throughput, and the cases where staying on Next.js is right.",
  "/blog/nextjs-alternatives-2026",
)

export default function NextjsAlternatives() {
  return (
    <article className="prose">
      <h1>Next.js alternatives in 2026</h1>
      <p>
        <em>
          Updated 2026-08-04 · Disclosure: we build nifra, one of the options below. SSR numbers are
          from our published, reproducible harness - including the rows we lose.
        </em>
      </p>

      <p className="lead">
        People leave Next.js for three reasons: App Router / RSC complexity, server-rendering cost,
        or Vercel coupling. Which alternative fits depends on which reason is yours - and for some
        teams the honest answer is to stay.
      </p>

      <h2>The field, with measured SSR throughput</h2>
      <p>
        Same dynamic data-loaded page, each framework's production build on Node, same machine
        (methodology + all rows: <a href="/benchmarks">benchmarks</a>):
      </p>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            <th>SSR req/s (Node)</th>
            <th>UI library</th>
            <th>Its strength</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>nifra (ours)</td>
            <td>27,144 (React) - 28,359 (Solid)</td>
            <td>React, Vue, Svelte, Solid, Preact</td>
            <td>Typed end-to-end, zero codegen, runtime-portable</td>
          </tr>
          <tr>
            <td>SolidStart</td>
            <td>7,211</td>
            <td>Solid</td>
            <td>Fine-grained reactivity, small bundles</td>
          </tr>
          <tr>
            <td>SvelteKit</td>
            <td>7,616</td>
            <td>Svelte</td>
            <td>Best authoring ergonomics, small bundles</td>
          </tr>
          <tr>
            <td>Nuxt 4</td>
            <td>2,816</td>
            <td>Vue</td>
            <td>Vue's full-stack home, mature module ecosystem</td>
          </tr>
          <tr>
            <td>Remix</td>
            <td>1,888</td>
            <td>React</td>
            <td>Web-standards model, now merging into React Router</td>
          </tr>
          <tr>
            <td>Next.js</td>
            <td>967</td>
            <td>React</td>
            <td>RSC, largest ecosystem, Vercel integration</td>
          </tr>
          <tr>
            <td>Astro</td>
            <td>(content-site shape - different category)</td>
            <td>Any, islands</td>
            <td>Content sites, minimal JS by default</td>
          </tr>
        </tbody>
      </table>

      <h2>Match the alternative to your reason</h2>
      <ul>
        <li>
          <strong>"RSC complexity is killing us, keeping React":</strong> nifra (streaming SSR +
          islands, no RSC, typed loaders/actions) or Remix/React Router. If your app is architected
          AROUND RSC, stay on Next.js - porting that model is a rewrite.
        </li>
        <li>
          <strong>"Server bill / SSR throughput":</strong> the table is the answer. This is where
          the gap is not subtle - it is an order of magnitude, and it is mostly meta-framework
          overhead, not React itself (<a href="/compare/nextjs">the breakdown</a>).
        </li>
        <li>
          <strong>"Vercel coupling":</strong> SvelteKit, Nuxt, and nifra all deploy anywhere; nifra
          additionally treats the runtime itself (Bun/Node/Deno/edge) as an adapter.
        </li>
        <li>
          <strong>"We want a different UI library":</strong> SvelteKit for Svelte, Nuxt for Vue,
          SolidStart for Solid - or nifra if you want the freedom to change that decision later
          without a backend rewrite (same routes and loaders across all five libraries).
        </li>
        <li>
          <strong>"Mostly content, little interactivity":</strong> Astro. Genuinely the right tool
          for that shape; nothing here competes with it on content sites.
        </li>
      </ul>

      <h2>Where nifra fits (and where it doesn't)</h2>
      <p>
        nifra is the pick when the API and frontend are one typed product: the client and loaders
        are inferred from the server's TypeScript (zero codegen), validation is on by default, SSR
        runs ~28x Next.js in our harness, and the docs/types are a{" "}
        <a href="/blog/docs-as-mcp">live MCP server</a> so AI agents build against the real API. It
        is NOT the pick if you need RSC itself, or the largest possible ecosystem of React-specific
        integrations - that is still Next.js, and we say so in the{" "}
        <a href="/compare/nextjs">full comparison</a>.
      </p>
      <p>
        Try the shape in one command:{" "}
        <code>bunx create-nifra my-app --template site --framework react</code> (or vue, svelte,
        solid, preact).
      </p>
    </article>
  )
}
