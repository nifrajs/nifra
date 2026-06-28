import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer + the Nira
// island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Troubleshooting",
  "Fixes keyed on the literal error strings Nifra prints: `reached the client bundle` (a node:/native import in the browser bundle), `server-only module reached the client bundle` (the server-only marker), and `resolveDispatcher` / `Invalid hook call` (duplicate React).",
)

// The server-only marker — the new opt-in client-leak guard. A pure-server module with no `node:`
// import (so the node-builtin guard can't catch it) opts in with the side-effect import; the type
// brand documents intent. This snippet imports from @nifrajs/web, so `check:docs` typechecks it.
const SERVER_ONLY_MARKER = `// secrets.ts — pure server logic: a secret constant, no \`node:\` import to catch.
import "@nifrajs/web/server-only"             // ← fails the CLIENT build (loud, with the import chain)
import type { ServerOnly } from "@nifrajs/web" // ← type-level intent: this value is server-only

// \`ServerOnly<string>\` is structurally \`string\` (the brand is an optional phantom field), so it
// stays assignment-compatible — it documents intent without obstructing real use.
export const apiKey: ServerOnly<string> = process.env.SECRET_API_KEY!

// If this module ever reaches a browser chunk, buildClient fails with:
//   server-only module reached the client bundle via routes/x.tsx → ./secrets.ts (marked server-only)
// Reach it from a loader/action (server-only) instead, and the secret never ships to the client.`

// The .server.ts convention — the auto-empty alternative. No marker import needed: the filename is
// the signal, and the client build replaces the module with an empty one. Multi-file by design
// (db.server.ts + routes/notes.tsx with a relative import), so it opts out of the single-file
// doc-check; the marker snippet above is the one check:docs typechecks against the live API.
const SERVER_CONVENTION = `// doc-check: skip — illustrative two-file layout (a relative cross-file import).
// db.server.ts — the \`.server\` convention: the client build EMPTIES this module, so its
// \`node:\` / native imports never ship to the browser. No marker import needed — the filename is it.
import { Database } from "bun:sqlite"
export const db = new Database("app.db")

// routes/notes.tsx — import the server module from a loader; it runs only on the server during SSR.
import type { LoaderContext } from "@nifrajs/web"
import { db } from "../db.server"
export async function loader(_ctx: LoaderContext) {
  return { notes: db.query("select * from notes").all() }
}`

export default function Troubleshooting() {
  return (
    <div className="prose">
      <h1 className="page">Troubleshooting</h1>
      <p className="lead">
        Hit an error? Search this page for the literal message. Each section is keyed on the exact
        string Nifra prints, with what it means and the fix. The build, <code>nifra check</code>, and
        the runtime all use the same wording so you can grep for it.
      </p>

      <h2><code>reached the client bundle</code> — a <code>node:</code> / native import leaked to the browser</h2>
      <p>
        The client build refuses to ship a Node built-in (<code>node:fs</code>, <code>node:crypto</code>,{" "}
        <code>bun:sqlite</code>, a native driver like <code>pg</code>) to the browser. Bun would
        silently substitute a polyfill that breaks — or leaks server code — at runtime, so Nifra fails
        the build instead. The message names the offending builtin and the <strong>import chain</strong>{" "}
        that pulled it in:
      </p>
      <blockquote>
        <p>
          [nifra/web] Node built-in(s) in the client bundle — move them behind a server-only path
          <br />
          {"  "}- node:crypto reached the client bundle via routes/x.tsx → ../data.ts → ../db.ts
          (chunk: x-abc123.js)
        </p>
      </blockquote>
      <p>
        Read the chain right-to-left: <code>../db.ts</code> imports <code>node:crypto</code>, and a
        top-level import in <code>routes/x.tsx</code> dragged it into the browser. <strong>Fix it one
        of two ways:</strong>
      </p>
      <ul>
        <li>
          <strong>Move the code into a <code>*.server.ts</code> module</strong> (the recommended
          default). The client build empties <code>*.server</code> modules, so their <code>node:</code>{" "}
          / native imports never reach the browser. Import the server module only from a loader/action
          (which run on the server).
        </li>
        <li>
          <strong>Reach the server code from a loader/action, not a route's top level.</strong> A
          loader runs on the server during SSR; importing the <code>node:</code> module inside (or via)
          a loader keeps it out of the client graph.
        </li>
      </ul>
      <CodeBlock code={SERVER_CONVENTION} />
      <blockquote>
        <p>
          [!TIP]
          <br />
          Run <code>nifra check</code> (or <code>nifra check --json</code> for agents) to catch this{" "}
          <em>before</em> the build: it reports the same transitive chain (
          <code>routes/x → ../data → ./db → node:crypto</code>) by walking the local module graph, so
          you see the leak as a lint result, not a failed build.
        </p>
      </blockquote>

      <h2><code>server-only module reached the client bundle</code> — the server-only marker fired</h2>
      <p>
        This is the companion guard for <strong>pure server logic that carries no <code>node:</code>{" "}
        import</strong> — a secret-bearing constant, a server-only API call — so the node-builtin guard
        above has nothing to catch and the <code>.server</code> convention needs the file to be{" "}
        <em>named</em> <code>*.server</code>. You opt a module in with a side-effect import, and the
        client build fails loud (with the import chain) if it ever lands in a browser chunk:
      </p>
      <blockquote>
        <p>
          [nifra/web] server-only module(s) in the client bundle — a module marked{" "}
          <code>import "@nifrajs/web/server-only"</code> reached the browser.
          <br />
          {"  "}- server-only module reached the client bundle via routes/x.tsx → ./secrets.ts (marked
          server-only)
        </p>
      </blockquote>
      <p>There are three markers; reach for them by intent:</p>
      <table>
        <thead>
          <tr>
            <th>marker</th>
            <th>enforcement</th>
            <th>use when</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>*.server.ts</code> filename
            </td>
            <td>client build auto-empties the module</td>
            <td>
              a dedicated server module (a DB client, a <code>node:</code> helper) you can name{" "}
              <code>*.server</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>import "@nifrajs/web/server-only"</code>
            </td>
            <td>client build fails loud, with the chain, if it leaks</td>
            <td>
              pure server logic with <strong>no <code>node:</code> import to catch</strong> (a secret,
              a server-only call) that you can't / don't want to rename
            </td>
          </tr>
          <tr>
            <td>
              <code>{"ServerOnly<T>"}</code> type
            </td>
            <td>type-level intent only — does NOT keep it out of the bundle</td>
            <td>
              documenting that a value must not cross to the browser; pair it with one of the two
              runtime markers
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        A worked example — a secret with no <code>node:</code> import, marked so a leak fails the build
        rather than shipping the key to every visitor:
      </p>
      <CodeBlock code={SERVER_ONLY_MARKER} />
      <p>
        <strong>Fix:</strong> reach the module from a loader/action (server-only), or rename it{" "}
        <code>*.server.ts</code> so the client build empties it. <code>nifra check</code> reports the
        same transitive chain pre-build. The <code>{"ServerOnly<T>"}</code> brand on its own is purely
        type-level (it erases at build), so always back it with the import marker or the{" "}
        <code>.server</code> filename.
      </p>

      <h2><code>resolveDispatcher</code> / <code>Invalid hook call</code> — duplicate React</h2>
      <p>
        If SSR throws <code>Cannot read properties of null (reading 'useState')</code> inside{" "}
        <code>resolveDispatcher</code>, or React logs <strong>"Invalid hook call. Hooks can only be
        called inside the body of a function component"</strong>, you almost certainly have{" "}
        <strong>two copies of React</strong> in one render. React's hook dispatcher is module-level
        global state; a second copy nulls it out and every hook throws.
      </p>
      <p>
        Nifra <strong>dedupes React</strong> in both the production build and the Vite dev server, so
        the framework itself won't load two copies. The usual culprit is a{" "}
        <strong><code>file:</code>-linked package</strong> (a local component library you{" "}
        <code>bun link</code> or reference with <code>file:../lib</code>) that bundles its own React in
        its own <code>node_modules</code>:
      </p>
      <ul>
        <li>
          Make React a <strong>peer dependency</strong> of the linked package (not a regular
          dependency), so it resolves to the app's single copy.
        </li>
        <li>
          Ensure one React version across the workspace — pin it in the root{" "}
          <code>package.json</code> <code>overrides</code> (Nifra's own repo pins{" "}
          <code>react</code> / <code>react-dom</code> this way) so every package resolves the same
          copy.
        </li>
        <li>
          Delete the linked package's nested <code>node_modules/react</code> after linking if your
          package manager duplicated it.
        </li>
      </ul>
      <blockquote>
        <p>
          [!NOTE]
          <br />
          This applies to every framework with module-global render state, not just React (Preact,
          Vue, Solid, Svelte). Nifra dedupes the active adapter's runtime in build and dev; a{" "}
          <code>file:</code>-linked package shipping its own copy is the thing to fix. See{" "}
          <a href="/docs/dev">Dev &amp; HMR</a> and the <code>file:</code>-linked-package note in{" "}
          <code>AGENTS.md</code>.
        </p>
      </blockquote>

      <h2>
        <code>{`client<typeof app>`}</code> resolves to <code>never</code> (or <code>data: never</code>)
      </h2>
      <p>The typed client is derived from your backend's type. Two things collapse it:</p>
      <ul>
        <li>
          <b>
            A route returns a raw <code>Response</code>.
          </b>{" "}
          That route's <code>data</code> infers <code>never</code> (Nifra can't see the shape). Return a
          plain object and shape the response with <code>c.set</code> — reach for <code>c.json</code> /{" "}
          <code>c.text</code> only for an error short-circuit (<code>throw</code> from a{" "}
          <code>derive</code> / <code>beforeHandle</code>), not a route's happy path. See{" "}
          <a href="/docs/api">API &amp; typed client</a>.
        </li>
        <li>
          <b>A plugin widened the app's type.</b> A plugin that registers routes/hooks but whose return
          type isn't the concrete server (e.g. an untyped <code>{`app => app.onResponse(…)`}</code>){" "}
          makes <code>.use()</code> return <code>{`Server<any, any>`}</code> and the client loses your
          registry. Build it with <code>defineRouterPlugin(name, …)</code> (the clearer-named{" "}
          <code>defineIdentityPlugin</code>) so <code>.use()</code> returns your server unchanged and
          routes added after it stay typed. See{" "}
          <a href="/docs/plugins">Plugins → keep types with defineRouterPlugin</a>.
        </li>
      </ul>
      <p>
        <code>nifra check</code> flags the raw-<code>Response</code> case; the plugin case surfaces as a{" "}
        <code>never</code> client at the call site.
      </p>
      <h3>
        Call site rejects <code>{`{ query: {…} }`}</code>
      </h3>
      <p>
        If <code>api.thing.get(&#123; query: &#123; … &#125; &#125;)</code> errors, the route declares no{" "}
        <code>query</code> schema — its query types as <code>never</code>, so the client can't accept query
        params. The error reads out the fix; add a schema to the route:{" "}
        <code>{`.get("/thing", { query: z.object({ page: z.string() }) }, h)`}</code>. Then{" "}
        <code>c.query</code> is the validated type and the client accepts a typed <code>query</code>.
      </p>

      <h2>Still stuck?</h2>
      <p>
        Run <code>nifra check --json</code> as the done-gate — it surfaces the import-chain leaks,
        typed-client drift, and raw-<code>Response</code>-from-a-route issues before you ship. The
        full machine-readable contract is at <a href="/llms-full.txt">/llms-full.txt</a>, and each
        package ships a tight <code>LLM.md</code> contract card.
      </p>
    </div>
  )
}
