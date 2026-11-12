import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/structure",
  "Nifra - Project structure",
  "Where code lives in a Nifra app: routes/, frontend/, backend/, shared/ and public/, the route pair, and the import rules the build enforces so server code never reaches the browser.",
)

const TREE = `my-app/
  routes/                 the URL tree: each page and its backend half
    _layout.tsx             wraps every page below it
    _layout.backend.ts      its middleware (runs on the server first)
    index.tsx               /            ships to the browser
    index.backend.ts                     its loader and action - never does
    users/
      [id].tsx              /users/:id
      [id].backend.ts
  frontend/               components, hooks, browser-only code
  backend/                app.ts (the API), framework.ts, db/, auth.ts
  shared/                 schemas, types and pure helpers both sides import
  public/                 static files, served as they are
  nifra.config.ts         tooling: the deploy target, the client module`

const PAGE = `// routes/users/[id].tsx - the page. It ships to the browser whole.
import type { Route } from "./+types/[id]"
import { Avatar } from "../../frontend/avatar"

export const meta = { title: "User" }

export default function User({ data }: Route.ComponentProps) {
  return (
    <main>
      <Avatar url={data.avatarUrl} />
      <h1>{data.name}</h1>
    </main>
  )
}`

const BACKEND_HALF = `// routes/users/[id].backend.ts - the page's server half. It never reaches the browser.
import { t } from "@nifrajs/schema"
import { notFound } from "@nifrajs/web"
import type { Route } from "./+types/[id]"

// What the page receives - and the ONLY fields that leave the server. A field the loader returns
// but the schema does not declare is dropped before rendering; in development the console names
// each dropped field, so a missing declaration never shows up as a silently blank page.
export const loaderOutput = t.object({ name: t.string(), avatarUrl: t.string() })

export async function loader({ params, api }: Route.LoaderArgs) {
  const res = await api.users({ id: params.id }).get()
  if (!res.ok) throw notFound()
  return res.data
}`

const ENTRY_SIDES = `{
  "name": "@shop/payments",
  "exports": {
    ".": "./src/index.ts",
    "./react": "./src/react.tsx",
    "./schema": "./src/schema.ts"
  },
  "nifra": {
    "environment": {
      ".": "backend",
      "./react": "frontend",
      "./schema": "library"
    }
  }
}`

const ZONES_SETTING = `{
  "name": "my-app",
  "nifra": {
    "zones": {
      "packages": { "@shop/*": "library", "@shop/db": "backend" },
      "backend": ["migrations", "src/ui/mailer.ts"],
      "frontend": ["src/ui"]
    }
  }
}`

const REFUSED = `[nifra/web] the browser build reached code that may not ship to a browser:
  - backend/db/index.ts: routes/users/[id].tsx (a route's frontend half) imports
    backend/db/index.ts (backend code): frontend code may not import backend code; reach it
    through a loader, an action or a *.fn.ts server function. A type-only import
    (\`import type\`) is allowed
      via routes/users/[id].tsx → backend/db/index.ts`

export default function Structure() {
  return (
    <div className="prose">
      <h1 className="page">Project structure</h1>
      <p className="lead">
        Every file a Nifra build loads belongs to one side: the browser, the server, or both. The
        folder says which, and the build refuses an import that crosses the wrong way - so server
        code and secrets cannot ship to the browser by accident.
      </p>

      <CodeBlock code={TREE} />

      <h2>The zones</h2>
      <table>
        <thead>
          <tr>
            <th>Where</th>
            <th>Holds</th>
            <th>Reaches the browser</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>routes/x.tsx</code> (<code>.svelte</code>, <code>.vue</code>, <code>.mdx</code>)
            </td>
            <td>
              a page: the component, <code>meta</code>,{" "}
              <a href={href({ to: "/docs/keep-alive" })}>
                <code>keepAlive</code>
              </a>
            </td>
            <td>yes</td>
          </tr>
          <tr>
            <td>
              <code>routes/x.backend.ts</code>
            </td>
            <td>
              that page's <code>loader</code>, <code>action</code>, <code>loaderOutput</code>,{" "}
              <code>actionOutput</code>, <code>hydrate</code>, <code>revalidate</code>,{" "}
              <code>shellLoader</code> and <code>boundaryLoaders</code> (a{" "}
              <a href={href({ to: "/docs/partial-prerendering" })}>partially prerendered</a> page),{" "}
              <code>middleware</code> (in <code>_layout.backend.ts</code>)
            </td>
            <td>never</td>
          </tr>
          <tr>
            <td>
              <code>frontend/</code>
            </td>
            <td>components, hooks, browser-only code</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>
              <code>backend/</code>
            </td>
            <td>
              <code>app.ts</code> (the API), <code>framework.ts</code>, the database, auth, secrets
            </td>
            <td>never</td>
          </tr>
          <tr>
            <td>
              <code>shared/</code>
            </td>
            <td>schemas, types, pure helpers both sides import</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>
              <code>public/</code>
            </td>
            <td>static files</td>
            <td>yes</td>
          </tr>
        </tbody>
      </table>
      <p>
        A file outside those folders joins a side with a suffix: <code>x.frontend.ts</code>,{" "}
        <code>x.backend.ts</code> or <code>x.shared.ts</code>. A workspace package declares its side
        in its <code>package.json</code>:{" "}
        <code>{'"nifra": { "environment": "frontend" | "backend" | "shared" | "library" }'}</code>.
        A file in no zone is a build error, so nothing is ever classified by accident.
      </p>
      <p>
        A package whose entries run on different sides gives each export subpath its own:
      </p>
      <CodeBlock code={ENTRY_SIDES} lang="json" />
      <p>
        An import is judged by the entry it names: the exact subpath first, then the most specific{" "}
        <code>*</code> pattern. Here a page may import <code>@shop/payments/react</code> but not{" "}
        <code>@shop/payments</code>, and backend code may not import the React entry, even when two
        entries are backed by one file. Importing an entry the map leaves out is an error. A file
        reached by path rather than by entry, through a relative or aliased deep import, takes the
        side of every mapped entry whose own imports reach it, and a file no mapped entry reaches is
        an error.
      </p>
      <p>
        The app's own <code>package.json</code> can set sides too, so a folder that has to stay
        where it is, or a family of workspace packages, needs no edit of its own:
      </p>
      <CodeBlock code={ZONES_SETTING} lang="json" />
      <p>
        <code>packages</code> gives a side to a package that does not declare one, by exact name or
        by a prefix ending in <code>*</code>; a package's own declaration always wins.{" "}
        <code>backend</code>, <code>frontend</code> and <code>shared</code> list app folders, or
        single files, that count as that zone. A path inside another's folder overrides it, so the
        most specific entry decides: above, <code>src/ui/mailer.ts</code> is backend code in a
        frontend folder. One path listed under two sides is refused. Builds, dev servers,{" "}
        <code>nifra check</code> and the editor plugin all read this setting.
      </p>
      <p>
        <code>frontend/</code> and <code>backend/</code> keep their own rules, with one exception: a
        module there that both sides import can be declared shared where it lives, by a{" "}
        <code>shared</code> entry naming it or by a <code>.shared</code> suffix. The entry changes no
        import; the suffix renames the file. Either way the module is then held to the shared rules
        (it may import only shared code and packages, and read no private environment variable), so
        the declaration narrows what it may reach and never widens it. When backend code imports a
        frontend module, NF-C028 says whether that module can be shared as it is, or names the import
        or environment read that stops it.
      </p>
      <p>
        A project that serves no pages has no browser, so the zones do not apply to it. Declare that
        in its <code>package.json</code> with <code>{'"nifra": { "kind": "api" }'}</code>:{" "}
        <code>nifra check</code> then skips the zone checks and the server-only import check there,
        and treats every file as server code. It is read from the nearest <code>package.json</code>{" "}
        and only takes values <code>"api"</code> and <code>"web"</code>. A directory with web config
        (<code>nifra.config.ts</code> exporting <code>adapter</code>, or{" "}
        <code>backend/framework.ts</code>) keeps its zone checks under it, and{" "}
        <code>nifra check</code> reports the clash (NF-C037); builds and dev servers never read it.
      </p>
      <p>
        A directory with <code>backend/app.ts</code> and no web config is read as an API-only app
        whether or not it declares the kind: <code>nifra routes</code>, <code>nifra context</code>,{" "}
        <code>nifra openapi</code> and <code>nifra mcp</code> load <code>backend/app.ts</code> alone,
        and the tools, resources and prompts its backend declares reach <code>nifra mcp</code>.
      </p>
      <p>
        Those commands, the contract lock and the route lints see only what{" "}
        <code>backend/app.ts</code> exports. An API whose app is built by a factory such as{" "}
        <code>createApp(deps)</code>, with its real dependencies wired in another entry, exports the
        same app from <code>backend/app.ts</code> built with stand-in dependencies, so every operation
        is visible without a database or secrets; <code>nifra check</code> names an implemented
        operation it does not serve (NF-C039). See{" "}
        <a href={href({ to: "/docs/types-first", hash: "stub-entry" })}>the stand-in entry</a>.
      </p>

      <h2>A route is two files</h2>
      <p>
        The page renders; its backend half loads. A server-only export (<code>loader</code>,{" "}
        <code>action</code>, <code>hydrate</code>, ...) in the page file is a build error that names
        the backend file it belongs in.
      </p>
      <CodeBlock code={PAGE} />
      <CodeBlock code={BACKEND_HALF} lang="ts" />
      <p>
        Both halves import <code>Route</code> from the generated <code>./+types/[id]</code>:{" "}
        <code>Route.LoaderArgs</code> carries the typed <code>params</code> and <code>api</code>,
        and <code>Route.ComponentProps</code> types <code>data</code> as exactly what{" "}
        <code>loaderOutput</code> lets through. <code>nifra dev</code>, <code>nifra build</code>,{" "}
        <code>nifra check</code> and <code>nifra types</code> write these files under{" "}
        <code>.nifra/types</code>; the app's <code>tsconfig.json</code> resolves them with{" "}
        <code>{'"rootDirs": [".", "./.nifra/types"]'}</code>. The same directory holds{" "}
        <code>routes.d.ts</code>, one entry per URL pattern with its params and search output, and
        every generated <code>./+types</code> module loads it.
      </p>

      <h2>What may import what</h2>
      <table>
        <thead>
          <tr>
            <th>From</th>
            <th>May import</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>a page, <code>frontend/</code></td>
            <td>
              frontend code, <code>shared/</code>, a <code>*.fn.ts</code> server function (the
              browser gets its RPC stub)
            </td>
          </tr>
          <tr>
            <td>a backend half, <code>backend/</code></td>
            <td>
              backend code, <code>shared/</code> - not frontend code (keep what both need in{" "}
              <code>shared/</code>)
            </td>
          </tr>
          <tr>
            <td>
              <code>shared/</code>
            </td>
            <td>
              <code>shared/</code> only
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Third-party packages are allowed on any side, except that browser code may not reach a
        server-only package (a database driver, a <code>node:</code> built-in). A type-only import (
        <code>import type</code>) is allowed anywhere: it is erased before bundling. A refused
        import fails the build with the chain that led to it:
      </p>
      <CodeBlock code={REFUSED} />

      <h2>Data and secrets</h2>
      <ul>
        <li>
          <b>Every loader and action declares what it sends</b> with <code>loaderOutput</code> /{" "}
          <code>actionOutput</code>. Only declared fields reach the browser, and{" "}
          <code>nifra check</code> flags a loader without one.
        </li>
        <li>
          <b>Browser code reads only public environment variables</b> - <code>NODE_ENV</code> and
          names with the <code>PUBLIC_</code> prefix. Any other <code>process.env</code> read in a
          page, <code>frontend/</code> or <code>shared/</code> fails the build, optional access (
          <code>process.env?.["SECRET"]</code>) included.
        </li>
        <li>
          <b>The build scans what it emits.</b> A client bundle, a public file or a prerendered page
          that contains what looks like a credential fails the build. A label in a message catalog (
          <code>{'{ password: "Password" }'}</code>) and a documented placeholder (
          <code>your-api-key</code>) are text, not credentials.
        </li>
      </ul>
      <p>
        The same rules run in <code>nifra dev</code> (a refused module is answered with a 403 before
        its source is sent), in both bundlers, for every framework, and in <code>nifra check</code>,
        which follows the imports the bundler follows: relative paths, tsconfig <code>paths</code>{" "}
        and <code>baseUrl</code>, <code>package.json</code> <code>imports</code>, and the{" "}
        <code>clientModule</code> the browser entry loads. An app on the older layout moves with{" "}
        <code>nifra migrate layout</code>: a dry run that reports every move, then{" "}
        <code>--write</code>. It follows the same imports, rewrites them and test-runner mocks (an
        alias through the same alias), and moves the config's <code>clientModule</code>, any module
        path the config builds from its own folder, and component pipeline entries with their
        modules. A test moves with the file beside it, snapshots included. Each{" "}
        <code>tsconfig*.json</code> keeps every file in, or out of, its program as before. It adds{" "}
        <code>.nifra/</code> to <code>.gitignore</code> and leaves data files and folders zoned in{" "}
        <code>package.json</code> where they are.
      </p>
      <p>
        A route file that holds server code splits into the page and its{" "}
        <code>x.backend.ts</code>. Data both halves read moves to <code>x.shared.ts</code> beside
        them; a value that cannot move is copied into each half and reported. A loader or action
        that returns data without an output schema gets a draft one, typed from what it returns:
        review that the browser may see every field it declares. The migration reports what still
        needs a hand, such as an alias with no target that covers a moved file, a specifier that
        names nothing installed, or a sibling workspace package that names a moved file. It never
        edits files outside the app.
      </p>
      <p>
        An API-only app, one that declares <code>{'"nifra": { "kind": "api" }'}</code> or has no web
        config, no <code>routes/</code> and a <code>backend.ts</code> that exports{" "}
        <code>backend</code>, migrates as one: only{" "}
        <code>backend.ts</code> moves, to <code>backend/app.ts</code>, with the imports from it and
        to it. Nothing is split or zoned. The migration adds <code>backend</code> to tsconfig{" "}
        <code>include</code>, <code>.nifra/</code> to <code>.gitignore</code>, and the declaration
        to <code>package.json</code> when it is missing. Web config without <code>routes/</code>{" "}
        could be either kind of app, so the migration stops and asks which. Until an app moves,{" "}
        <code>nifra check</code> fails with NF-C038 on its root <code>backend.ts</code> or{" "}
        <code>framework.ts</code>, since no contract gate reads them there.
      </p>
    </div>
  )
}
