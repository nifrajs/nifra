import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/migrate-5",
  "Nifra 5 upgrade guide - from 3.x, 4.x or an earlier 5.x",
  "Upgrade a Nifra 3.x or 4.x application to 5.0: the chained upgrade command, the frontend/backend layout move and its follow-ups, drafted output schemas, the backend's HTTP mount, the 5.0 defaults that changed, and the release gates. Then move a 5.x app to 5.6.",
)

const COMMANDS = [
  "bunx @nifrajs/cli@5.0.0 upgrade 5.0.0          # dry run: every release step from the installed version",
  "bunx @nifrajs/cli@5.0.0 upgrade 5.0.0 --write  # apply the pins and import moves",
  "bun install",
].join("\n")

const LAYOUT = [
  "nifra migrate layout            # dry run: splits, moves, rewritten imports, issues",
  "nifra migrate layout --write    # apply it",
  "nifra schemas --write           # draft the output schemas it lists as follow-ups",
  "nifra check",
].join("\n")

const ZONES = [
  "{",
  '  "nifra": {',
  '    "zones": {',
  '      "frontend": ["src/ui"],',
  '      "backend": ["server"]',
  "    }",
  "  }",
  "}",
].join("\n")

const SPLIT = [
  "// doc-check: skip - a route split into its two halves",
  "// routes/notes.tsx - the page, shipped to the browser whole",
  'import type { loader } from "./notes.backend.ts"',
  "export default function Notes({ data }: { data: Awaited<ReturnType<typeof loader>> }) {",
  "  return <ul>{data.notes.map((note) => <li key={note.id}>{note.title}</li>)}</ul>",
  "}",
  "",
  "// routes/notes.backend.ts - loader, action, middleware and the other server exports",
  'import { t } from "@nifrajs/schema"',
  "export const loaderOutput = t.object({",
  "  notes: t.array(t.object({ id: t.string(), title: t.string() })),",
  "})",
  "export async function loader() {",
  "  return { notes: await listNotes() }",
  "}",
].join("\n")

const MOUNT = [
  "// doc-check: skip - backend/framework.ts",
  'export { reactAdapter as adapter } from "@nifrajs/web-react"',
  "",
  '// Serve backend/app.ts at /api, as 3.x and 4.x did by default. "" keeps it loader-only.',
  'export const apiPrefix = "/api"',
].join("\n")

export default function Migrate5() {
  return (
    <div className="prose">
      <h1 className="page">Upgrading to Nifra 5</h1>
      <p className="lead">
        Nifra 4.0 split every app into a frontend and a backend half, and 5.0 enforces the split and
        changes a handful of defaults. The upgrade command pins the packages and moves imports; the
        layout migration moves files; this guide covers what each leaves to you and how to tell a
        finished migration from one that needs a decision. An app already on 5.x skips to{" "}
        <a href="#5-6">Moving to 5.6</a>.
      </p>

      <h2>1. Run the executable upgrade</h2>
      <CodeBlock code={COMMANDS} lang="sh" />
      <p>
        Run the command from the release you are moving to. It chains every release recipe between
        the installed version and 5.0, so a 3.x app takes the 4.0 steps (the retired{" "}
        <code>@nifrajs/web/server-only</code> import moves to <code>@nifrajs/web/backend-only</code>)
        and the 5.0 ones in one pass, and prints each release's notes. It lists every{" "}
        <code>@nifra-gate-reviewed</code> comment, which silences nothing in 5.0: after review, write{" "}
        <code>{"// nifra-expect <code>: <reason>"}</code> with the code <code>nifra check</code>{" "}
        reports there. The upgrade never writes a reason for you.
      </p>

      <h2>2. Move onto the frontend/backend layout (from 3.x)</h2>
      <CodeBlock code={LAYOUT} lang="sh" />
      <p>
        Each route file splits into <code>x.tsx</code>, the page, and <code>x.backend.ts</code>, which
        holds <code>loader</code>, <code>action</code>, <code>middleware</code> and the other server
        exports. The root <code>backend.ts</code> and <code>framework.ts</code> move to{" "}
        <code>backend/app.ts</code> and <code>backend/framework.ts</code>, and every other module goes
        to <code>frontend/</code>, <code>backend/</code> or <code>shared/</code> by who imports it at
        runtime. A folder whose imported files all land in one zone moves whole, so a component nothing
        imports yet travels with its folder; a folder split between zones is reported instead.
      </p>
      <CodeBlock code={SPLIT} lang="tsx" />
      <p>
        To keep a folder where it is, declare it a zone before migrating. The migration leaves zoned
        folders in place, and builds, <code>nifra dev</code> and <code>nifra check</code> enforce them
        like the default folders.
      </p>
      <CodeBlock code={ZONES} lang="json" />
      <p>
        <code>nifra migrate layout --zones</code> writes those entries for you: every module the
        layout would move stays where it is, and <code>package.json</code> lists the widest folder
        whose files all belong to one side, or the file itself where its folder holds both. Route
        files are still split and the root entries still move. A path nested in another's folder
        overrides it, so a backend file can sit in a frontend folder without moving.
      </p>
      <p>
        The command exits <code>0</code> when nothing needs a decision. A step with a known command,
        such as drafting an output schema for a backend half it did not write, is listed under{" "}
        <code>next</code> and in <code>followUps</code> with <code>--json</code>, and does not fail it;
        so is a moved path a module names only in comments, which is worth updating but changes
        nothing that runs. An issue (an import it could not place, a frontend that still uses a moved
        name at runtime, a moved path written in code or a string) exits <code>1</code>.
      </p>
      <p>
        5.0 refuses a route file that still exports a server name: <code>nifra build</code> and the
        server stop on it, and <code>nifra check</code> reports it as NF-C041.{" "}
        <code>nifra fix --code NF-C041</code> moves the export and the code only it uses into the
        route's backend half.
      </p>

      <h2>3. Draft and review output schemas</h2>
      <p>
        A loader or action that returns data needs <code>loaderOutput</code> or{" "}
        <code>actionOutput</code>; the data is projected through it, so undeclared keys never reach
        the page. <code>nifra schemas --write</code> drafts each missing one from the function's return
        type, leaves out credential-like fields and marks it <code>nifra:generated</code> so later runs
        keep it current. A value typed <code>any</code> or <code>unknown</code> drafts as{" "}
        <code>t.json()</code>, which admits anything: <code>nifra schemas</code> lists those paths and{" "}
        <code>nifra check</code> warns on them (NF-C030). Give the value a type and draft again.{" "}
        <code>nifra schemas --check</code> fails on a missing, stale or open schema, for CI.
      </p>

      <h2>4. Choose where the backend is served</h2>
      <p>
        3.x and 4.x served <code>backend/app.ts</code> at <code>/api</code> by default. In 5.0{" "}
        <code>createWebApp</code> serves it over HTTP only at an <code>apiPrefix</code> the app sets;
        without one the backend is loader-only, reached in-process through <code>ctx.api</code>, and a
        browser call to <code>/api</code> reaches page routing. <code>nifra migrate layout</code> adds{" "}
        <code>apiPrefix = "/api"</code> when it moves a root <code>backend.ts</code>, and{" "}
        <code>nifra check</code> reports a framework config that sets none (NF-C035).
      </p>
      <CodeBlock code={MOUNT} lang="ts" />
      <p>
        With both <code>nifra.config.ts</code> and <code>backend/framework.ts</code>, every command
        takes <code>apiPrefix</code>, <code>apiStrip</code>, <code>mounts</code>, <code>csp</code>,{" "}
        <code>nonce</code>, <code>serverComponents</code>, <code>use</code> and{" "}
        <code>publicEnvPrefix</code> from <code>backend/framework.ts</code> when{" "}
        <code>nifra.config.ts</code> leaves them unset. The
        backend sees each request's full path unless <code>apiStrip</code> is on, so its routes are
        registered under the prefix; <code>nifra routes</code> marks one outside it as in-process
        only, and <code>nifra dev</code> and <code>nifra build</code> warn about it.
      </p>
      <p>
        An app that strips the prefix itself, with a <code>Proxy</code> or a wrapper around the
        backend's <code>fetch</code> that cuts <code>/api</code> before routing, gets that warning
        for every route: the check reads the registered paths, and a rewrite at run time is invisible
        to it. Delete the wrapper and export <code>apiStrip = true</code> beside{" "}
        <code>apiPrefix</code>, which does the same cut where the framework can see it. A second
        prefix the wrapper served (a <code>/v1</code> alias, a webhook path) becomes an entry in{" "}
        <code>mounts</code>.
      </p>

      <h2>5. Review the 5.0 defaults that changed</h2>
      <ul>
        <li>
          Root status pages (<code>_404.tsx</code>, <code>_&lt;status&gt;.tsx</code>) and{" "}
          <code>_error.tsx</code> render inside the layouts above them. One that imports the root
          layout to wrap itself renders it twice (NF-C034); remove the wrap, or export{" "}
          <code>inLayouts = false</code>.
        </li>
        <li>
          A layout's <code>meta</code> receives its own loader data as <code>data</code> and the page's
          as <code>pageData</code> (NF-C040).
        </li>
        <li>
          A WebSocket handshake runs the route chain an HTTP <code>GET</code> at the same point runs, so
          guards added before <code>app.ws()</code> apply to it.
        </li>
        <li>
          A <code>Response</code> returned to more than one request is no longer shared; build one per
          request.
        </li>
        <li>
          <code>nifra check</code> fails a secret comparison (NF-S002) outside browser code of a web
          app.
        </li>
      </ul>
      <p>
        From 3.x, two 4.0 changes also show up in tests and tooling rather than in pages:
      </p>
      <ul>
        <li>
          Page data is handed over in one{" "}
          <code>{'<script type="application/json" id="__nifra-handover">'}</code>, not a script that
          assigns <code>window.__NIFRA_DATA__</code>. A test that read the data out of the HTML
          parses that element (<code>HANDOVER_ID</code> from <code>@nifrajs/web</code>).
        </li>
        <li>
          <code>x-nifra-isr-revalidate</code> and <code>x-nifra-isr-tags</code> are set only under a
          cache wrapper such as <code>withISR</code>, which removes them before responding. A test
          that read a page's TTL from them on an unwrapped app reads nothing.
        </li>
      </ul>
      <p>
        <code>nifra upgrade</code> prints the full list with the finding or the one-line change that
        keeps the 4.x behavior for each.
      </p>
      <p>
        Past 5.0, 5.1 adds one change a frontend on another origin sees. A route with a{" "}
        <code>body</code> schema answers a urlencoded, multipart or <code>text/plain</code> body whose{" "}
        <code>Origin</code> names another site with <code>403 forbidden_origin</code>, before reading
        it. List that frontend&rsquo;s origin, or an identity provider&rsquo;s for a{" "}
        <code>form_post</code> callback, in the <code>formOrigins</code> server option (an array of
        exact origins or a function; <code>@nifrajs/edge</code> takes it too). JSON bodies are
        unchanged. <a href={href({ to: "/docs/security" })}>Security</a> covers what the check leaves to{" "}
        <code>csrf()</code>.
      </p>

      <h2>6. Run the release gates</h2>
      <ol>
        <li>
          Run <code>nifra check --json</code> and fix every error. <code>nifra doctor</code> lists any
          package still on another release.
        </li>
        <li>
          If the project has <code>nifra.assurance.ts</code>, run <code>nifra assure --json</code>.
        </li>
        <li>Run the application test suite and a production build.</li>
        <li>
          Exercise the pages that load or post data, and every browser call to the backend, under{" "}
          <code>nifra dev</code> and against the production build.
        </li>
      </ol>

      <h2 id="5-6">Moving to 5.6</h2>
      <p>
        An app already on 5.x moves with <code>nifra upgrade 5.6.0</code>, which prints every note
        below with the rest of the release&apos;s. It moves the imports and dependencies itself; the
        rest needs a hand:
      </p>
      <ul>
        <li>
          <code>@nifrajs/islets</code> and <code>@nifrajs/web/nano</code> merge into{" "}
          <code>@nifrajs/web/islands</code>. An island host is any element with{" "}
          <code>data-island=&quot;id&quot;</code>, with its props in{" "}
          <code>data-island-props</code>; <code>&lt;nifra-island data-id&gt;</code> markers are no
          longer mounted. An islets <code>island(&quot;id&quot;, setup)</code> becomes{" "}
          <code>bindIsland(setup)</code> passed to <code>mountIslands(&#123; id &#125;)</code>, and a
          nano signal is read by calling it (<code>count()</code>). See{" "}
          <a href={href({ to: "/docs/islands" })}>Islands</a>.
        </li>
        <li>
          <code>withISR</code> over any store but <code>MemoryCacheStore</code> takes a{" "}
          <code>storeSecret</code> of at least 32 random characters, the same in every process, and
          throws at startup without one. Pages stored before the upgrade render once more.
        </li>
        <li>
          The server-component pipeline is certified on Vite 8.3.4: pin <code>vite</code> to exactly
          that version.
        </li>
        <li>
          An <code>authenticate()</code> stage, and <code>bearer()</code>, <code>jwt()</code>,{" "}
          <code>basicAuth()</code> and <code>apiKey()</code>, gate the mounts registered after them:
          register a mount that must stay public first. <code>idempotency()</code> covers only the
          routes declared after it.
        </li>
        <li>
          <code>t.integer()</code> refuses values past the safe-integer range by default, forms are
          parsed by one parser on every runtime, and <code>@nifrajs/web-vanilla</code>&apos;s{" "}
          <code>html</code> escapes each value for the place it lands and throws on a string as a
          tag name or inside <code>&lt;script&gt;</code>.
        </li>
        <li>
          A Svelte page receives <code>data</code> as the router published it, not a deep reactive
          proxy: copy what you edit into the page&apos;s own state.
        </li>
      </ul>
    </div>
  )
}
