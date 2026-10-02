import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/troubleshooting",
  "Nifra - Troubleshooting",
  "Fixes keyed on the literal error strings Nifra prints: `reached the client bundle` (a node:/native import in the browser bundle), `server-only module reached the client bundle` (the server-only marker), `resolveDispatcher` / `Invalid hook call` (duplicate React), and `@nifrajs/core is loaded 2 times` (duplicate core).",
)

// The backend-only marker, for server code whose location does not already say so. This snippet
// imports from @nifrajs/web, so `check:docs` typechecks it against the live API.
const BACKEND_ONLY_MARKER = `// packages/billing/src/keys.ts - a workspace package both sides import, holding one server value.
import "@nifrajs/web/backend-only"             // ← a browser build that reaches this module fails
import type { BackendOnly } from "@nifrajs/web" // ← type-level intent: this value stays on the server

// \`BackendOnly<string>\` is structurally \`string\` (the brand is an optional phantom field), so it
// stays assignment-compatible - it documents intent without obstructing real use.
export const apiKey: BackendOnly<string> = process.env.SECRET_API_KEY!`

// The route split: the page ships to the browser whole, its backend half never does.
const ROUTE_SPLIT = `// doc-check: skip - illustrative three-file layout (relative cross-file imports).
// backend/db.ts - backend code: no browser build may load it.
import { Database } from "bun:sqlite"
export const db = new Database("app.db")

// routes/notes.backend.ts - the route's backend half: loader, action, output schemas.
import { t } from "@nifrajs/schema"
import { db } from "../backend/db.ts"
export const loaderOutput = t.object({ notes: t.array(t.object({ title: t.string() })) })
export const loader = () => ({ notes: db.query("select title from notes").all() })

// routes/notes.tsx - the page: it renders the loader's data and imports nothing from backend/.
export default function Notes({ data }) {
  return data.notes.map((note) => <p>{note.title}</p>)
}`

// The single-copy declaration. Static, in package.json, because `nifra check` must be able to read it
// without importing the app's config - reading plugins would mean executing app code in a preflight.
const SINGLE_COPY_DECLARATION = `{
  "name": "my-app",
  "dependencies": {
    "react": "19.2.8",
    "@example/ui": "link:../design-system/packages/ui"
  },
  "nifra": {
    "singleCopy": ["react", "react-dom", "@nifrajs/*"]
  }
}`

// The runtime arm. The build injects the resolver itself; nothing bundles \`bun test\`, so the
// registrar has to be preloaded there or both copies load again.
const SINGLE_COPY_PRELOAD = `# bunfig.toml
preload = ["@nifrajs/core/single-copy/register"]

[test]
preload = ["@nifrajs/core/single-copy/register"]`

// Fix 1 for TS2589: split one long chain into domain groups and merge() them. Each group is its own
// short server() chain (well under the ceiling), and merge() is a single R & R2 intersection with no
// per-call context work - so the cost stays flat however many groups you compose. Self-contained
// (imports @nifrajs/core, declares everything it uses), so check:docs typechecks it against the live API.
const MERGE_SPLIT = `import { server } from "@nifrajs/core"

// Each domain is its OWN short server() chain, kept well under the ~95-route ceiling.
const users = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", () => ({ created: true }))

const orders = server()
  .get("/orders/:id", (c) => ({ id: c.params.id }))
  .post("/orders", () => ({ placed: true }))

// merge() adds ONE R & R2 intersection per group - no per-call context recompute - so the whole
// app stays inside tsc's budget no matter how many groups (or routes) you compose.
export const app = server()
  .get("/health", () => ({ ok: true }))
  .merge(users)
  .merge(orders)`

// Fix 2 for TS2589: contract-first. defineContract declares the whole registry as ONE object type
// upfront; implement() binds handlers to it. The registry is not grown one alias level per call, so
// there is no per-expression accumulation and no ceiling at any route count. Also self-contained.
const CONTRACT_FIRST = `import { defineContract, implement } from "@nifrajs/core/contract"

// One object type, declared upfront - NOT an N-deep stack of \`Server<AddRoute<…>>\` aliases.
const contract = defineContract({
  getUser:    { method: "GET",  path: "/users/:id" },
  listUsers:  { method: "GET",  path: "/users" },
  createUser: { method: "POST", path: "/users" },
  // ...hundreds more operations stay flat: the registry is one type, not a growing chain.
})

export const app = implement(contract, {
  getUser:    (c) => ({ id: c.params.id }),
  listUsers:  () => ({ users: [] as string[] }),
  createUser: () => ({ created: true }),
})`

export default function Troubleshooting() {
  return (
    <div className="prose">
      <h1 className="page">Troubleshooting</h1>
      <p className="lead">
        Hit an error? Search this page for the literal message. Each section is keyed on the exact
        string Nifra prints, with what it means and the fix. The build, <code>nifra check</code>, and
        the runtime all use the same wording so you can grep for it.
      </p>

      <h2><code>may not ship to a browser</code> - backend code reached a browser build</h2>
      <p>
        Every browser build (Bun and Vite, production and dev) refuses code that belongs to the server:
        anything under <code>backend/</code>, a route's <code>x.backend.ts</code> half, a{" "}
        <code>node:</code> or <code>bun:</code> built-in, a server package (a database driver, a server
        SDK), and any module that imports <code>@nifrajs/web/backend-only</code>. The message names the
        module, why it may not ship, and the <strong>import chain</strong> that reached it:
      </p>
      <blockquote>
        <p>
          [nifra/web] the browser build reached code that may not ship to a browser:
          <br />
          {"  "}- backend/db.ts: it is backend code
          <br />
          {"      "}via routes/notes.tsx → backend/db.ts
        </p>
      </blockquote>
      <p>
        Read the chain left to right: the page <code>routes/notes.tsx</code> imports{" "}
        <code>backend/db.ts</code>. <strong>Fix it by where the code runs:</strong>
      </p>
      <ul>
        <li>
          <strong>Data for the page</strong> comes from the route's backend half: a{" "}
          <code>loader</code> in <code>routes/notes.backend.ts</code>, with the output schema that
          declares what the browser may see.
        </li>
        <li>
          <strong>A call from the browser</strong> goes through a <code>*.fn.ts</code> server
          function, which the browser build replaces with a fetch stub.
        </li>
        <li>
          <strong>Code both sides need</strong> (types, formatting, validation) moves to{" "}
          <code>shared/</code>, which may import only shared code.
        </li>
      </ul>
      <CodeBlock code={ROUTE_SPLIT} />
      <p>
        Server code whose location does not say so - say, a workspace package both sides import - opts
        out of every browser build with the marker import:
      </p>
      <CodeBlock code={BACKEND_ONLY_MARKER} />
      <blockquote>
        <p>
          [!TIP]
          <br />
          Run <code>nifra check</code> (or <code>nifra check --json</code> for agents) to catch this{" "}
          <em>before</em> the build: it reports the same chain from source. An app still on{" "}
          <code>*.server.ts</code> files and <code>@nifrajs/web/server-only</code> moves over with{" "}
          <code>nifra migrate layout</code>.
        </p>
      </blockquote>

      <h2><code>resolveDispatcher</code> / <code>Invalid hook call</code> - duplicate React</h2>
      <p>
        If SSR throws <code>Cannot read properties of null (reading 'useState')</code> inside{" "}
        <code>resolveDispatcher</code>, or React logs <strong>"Invalid hook call. Hooks can only be
        called inside the body of a function component"</strong>, you almost certainly have{" "}
        <strong>two copies of React</strong> in one render. React's hook dispatcher is module-level
        global state; a second copy nulls it out and every hook throws. Under{" "}
        <code>@nifrajs/web-react</code> the render fails with{" "}
        <code>[nifra/web-react] a component called a React hook with no dispatcher</code> instead,
        with the engine's original message kept in parentheses and as the error's <code>cause</code>.
      </p>
      <p>
        Nifra <strong>dedupes React</strong> in both the production build and the Vite dev server, so
        the framework itself won't load two copies. The usual culprit is a{" "}
        <strong><code>file:</code>- or <code>link:</code>-linked package</strong> (a local component
        library you <code>bun link</code> or reference with <code>link:../lib</code>) that bundles its
        own React in its own <code>node_modules</code>. Fix the install first, if you can:
      </p>
      <ul>
        <li>
          Make React a <strong>peer dependency</strong> of the linked package (not a regular
          dependency), so it resolves to the app's single copy.
        </li>
        <li>
          Ensure one React version across the workspace - pin it in the root{" "}
          <code>package.json</code> <code>overrides</code> (Nifra's own repo pins{" "}
          <code>react</code> / <code>react-dom</code> this way) so every package resolves the same
          copy.
        </li>
        <li>
          Delete the linked package's nested <code>node_modules/react</code> after linking if your
          package manager duplicated it.
        </li>
      </ul>

      <h3>When the duplicate can't be installed away: declare it single-copy</h3>
      <p>
        A <code>link:</code> dependency on a <strong>separate checkout</strong> is the case none of the
        above reaches. The linked package's files live in the other repo, so Node and Bun resolve their
        imports from <em>that</em> repo's real path - and that repo's install owns its{" "}
        <code>node_modules</code>. Peer deps don't help (the copy is already installed there),{" "}
        <code>overrides</code> don't help (they govern your install, not theirs), and deleting the
        nested copy is undone by the next install in the sibling repo. Only a resolver can answer this:
        the walk has to be intercepted, not rearranged.
      </p>
      <p>
        Declare the packages in your app's <code>package.json</code>. It is a <strong>static</strong>{" "}
        declaration on purpose - <code>nifra check</code> reads it without importing your config, so
        the preflight never executes app code:
      </p>
      <CodeBlock code={SINGLE_COPY_DECLARATION} lang="json" />
      <p>
        <code>"singleCopy": true</code> is shorthand for Nifra's built-in identity-sensitive set:{" "}
        <code>@nifrajs/*</code>, <code>react</code>, <code>react-dom</code>, <code>preact</code>,{" "}
        <code>solid-js</code>, <code>svelte</code>, <code>vue</code>. Entries may be exact names or a{" "}
        <code>@scope/*</code> pattern. <code>@nifrajs/*</code> belongs in this set for the same reason
        React does: two copies of <code>@nifrajs/core</code> are two distinct <code>Server</code>{" "}
        classes with separate request state. The second copy prints{" "}
        <code>[nifra] @nifrajs/core is loaded 2 times</code> with the path of each as it loads, and{" "}
        <code>.merge()</code> refuses a server built against the other copy with{" "}
        <code>merge() requires a server() from this copy of @nifrajs/core</code>. A{" "}
        <code>mount()</code> crosses only the fetch boundary, so it keeps working across copies.
      </p>
      <p>
        <strong>The build honours the declaration on its own</strong> -{" "}
        <code>buildClient</code> and <code>buildServer</code> inject the resolver, so bundled output
        already loads one copy. Unbundled phases do not: Bun's <em>runtime</em> resolver never offers a
        bare specifier to a plugin, so <code>bun test</code>, <code>bun run</code>, and preloaded
        scripts still load both copies unless you preload the registrar:
      </p>
      <CodeBlock code={SINGLE_COPY_PRELOAD} lang="toml" />
      <p>
        Both sections matter, and they are independent: <code>preload</code> covers{" "}
        <code>bun run</code>, <code>[test].preload</code> covers <code>bun test</code>. Declaring
        without preloading is a real state, not a mistake -{" "}
        <code>nifra check</code> reports it and names the phase left uncovered.
      </p>
      <p>
        <strong>What it will not do:</strong> redirect across <em>versions</em>. If the two copies are{" "}
        <code>19.2.7</code> and <code>19.2.8</code>, the redirect is skipped and{" "}
        <code>nifra check</code> still fails with <code>version-skew</code> - for every declared
        package, not only the built-in set. Silently collapsing a version difference would trade a loud
        install problem for a quiet behavioural one; align the ranges instead.
      </p>
      <p>
        The preloaded registrar never skips quietly either. A declared package it cannot collapse - a
        version skew, or a linked file with no counterpart in your copy - prints one warning per
        package naming both copies and both versions. To make that a startup failure, use the object
        form <code>{`"singleCopy": { "packages": [...], "strict": true }`}</code> or set{" "}
        <code>NIFRA_SINGLE_COPY_STRICT=1</code>.
      </p>
      <p>
        A declared duplicate is <strong>reported, not suppressed</strong>.{" "}
        <code>nifra check</code> keeps printing the copies as a warning and{" "}
        <code>nifra doctor</code> lists them under "deduplicated by declaration", so the topology stays
        visible - it just stops being fatal.
      </p>
      <p>
        <strong>A copy someone else planted is named.</strong> When an importer reaches a copy through a
        symlink that points outside its own install - another project's <code>node_modules</code>{" "}
        linked into a shared package, or a <code>bun link</code> - <code>nifra doctor</code> prints a{" "}
        <code>links:</code> line with the link and its target, and <code>nifra check</code> puts it
        ahead of both fixes. Removing that link and reinstalling there is usually the whole fix.
        Package-manager store links inside an install (<code>.bun/</code>, <code>.pnpm/</code>) are
        never reported.
      </p>
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
          plain object and shape the response with <code>c.set</code> - reach for <code>c.json</code> /{" "}
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
        <code>query</code> schema - its query types as <code>never</code>, so the client can't accept query
        params. The error reads out the fix; add a schema to the route:{" "}
        <code>{`.get("/thing", { query: z.object({ page: z.string() }) }, h)`}</code>. Then{" "}
        <code>c.query</code> is the validated type and the client accepts a typed <code>query</code>.
      </p>

      <h2>
        <code>TS2589</code> - "Type instantiation is excessively deep and possibly infinite" (one{" "}
        <code>server()</code> chain grew past ~95 routes)
      </h2>
      <p>
        The fluent builder's whole value - end-to-end inference, so <code>c.params.id</code> is typed
        straight from <code>:id</code> and the client is derived from <code>typeof app</code> - carries
        an <strong>O(N) type-instantiation cost</strong>. Each <code>.get(path, handler)</code> /{" "}
        <code>.post(...)</code> does two things at once: it computes the handler's context type from the
        path, <em>and</em> it returns a server whose registry is one alias level deeper than the last.
        Neither strains the compiler alone; the <strong>product</strong> - recomputing the handler
        context while re-threading an ever-larger registry at every step - exhausts TypeScript's
        per-expression instantiation budget. A single chain hits <code>TS2589</code> at{" "}
        <strong>~95-100 routes</strong>.
      </p>
      <blockquote>
        <p>
          [!NOTE]
          <br />
          This is a <strong>healthy, growing app's wall, not abuse</strong>. It is inherent to any
          builder that infers handler context <em>and</em> accumulates a typed route registry (Elysia,
          tRPC, and Hono's typed clients cap the same way), so it is not fixable by reshaping the
          internal <code>AddRoute</code>. The fix is to use a shape that does not form the product.
        </p>
      </blockquote>
      <p>
        <strong>Fix 1 - split into domain groups and <code>.merge()</code> them.</strong> Each group is
        its own short <code>server()</code> chain, so no single chain approaches the ceiling; a{" "}
        <code>.merge()</code> is one <code>R &amp; R2</code> intersection with no per-call context work,
        so composing groups stays cheap. A 90-route single chain is inside the ceiling; 120 routes as
        four merged 30-route groups typecheck with full per-route fidelity.
      </p>
      <CodeBlock code={MERGE_SPLIT} />
      <p>
        <strong>Fix 2 - go contract-first, and stay flat at any route count.</strong>{" "}
        <code>defineContract(...)</code> declares the entire registry as <strong>one object type
        upfront</strong>, and <code>implement(contract, handlers)</code> binds handlers to it. Nothing
        grows a registry per call, so there is <strong>no ceiling at all</strong> - this is the path for
        an API that will keep adding routes for years. Handlers stay checked against the contract exactly
        as inline routes are. See <a href="/docs/contract">Contract-first</a>.
      </p>
      <CodeBlock code={CONTRACT_FIRST} />
      <h3>
        <code>TS2345</code> from an unrelated <code>.merge()</code> - budget exhausted "at a distance"
      </h3>
      <p>
        Because the budget is per-expression and global to a compilation, a type-heavy construct{" "}
        <em>elsewhere</em> in the program can push an otherwise-fine <code>.merge()</code> chain over the
        edge. It surfaces not as <code>TS2589</code> but as a <code>TS2345</code> assignability error
        naming an <strong>uninstantiated</strong> <code>{"Server<Registry, unknown>"}</code> - the shape
        the server type collapses to when the compiler gives up mid-inference. The usual trigger is a{" "}
        <strong>generic higher-order function that wraps the builder</strong> (a{" "}
        <code>{"withX<T>(app)"}</code> that threads the <code>Server</code> type through its own type
        parameters); merely having that file in the program can be enough. Treat these as real
        constraints of an inference-first framework:
      </p>
      <ul>
        <li>
          Keep <strong>service-layer types flat and explicitly annotated</strong> - do not let
          inference-heavy generics thread the <code>Server</code> / registry type through your own code.
        </li>
        <li>
          <strong>Avoid generic HOF wrappers around the builder.</strong> Wrap with a{" "}
          <code>defineRouterPlugin</code> (identity plugin) or compose with <code>.merge()</code> instead
          of a <code>{"withX<T>(app)"}</code> that re-infers the whole server type.
        </li>
        <li>
          Put an explicit <code>{"Promise<T>"}</code> return annotation on async callbacks that thread
          framework types, so the compiler stops re-deriving the awaited type at each use.
        </li>
      </ul>
      <blockquote>
        <p>
          [!TIP]
          <br />
          Both fixes preserve full type fidelity - the client derived from <code>typeof app</code> is
          exactly as precise after a <code>.merge()</code> or an <code>implement()</code> as it is for an
          inline route. Splitting or going contract-first costs you nothing at the call site.
        </p>
      </blockquote>

      <h2>Still stuck?</h2>
      <p>
        Run <code>nifra check --json</code> as the done-gate - it surfaces the import-chain leaks,
        typed-client drift, and raw-<code>Response</code>-from-a-route issues before you ship. The
        full machine-readable contract is at <a href="/llms-full.txt">/llms-full.txt</a>, and each
        package ships a tight <code>LLM.md</code> contract card.
      </p>
    </div>
  )
}
