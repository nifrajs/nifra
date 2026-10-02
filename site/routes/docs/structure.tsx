import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

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
// but the schema does not declare is dropped before rendering.
export const loaderOutput = t.object({ name: t.string(), avatarUrl: t.string() })

export async function loader({ params, api }: Route.LoaderArgs) {
  const res = await api.users({ id: params.id }).get()
  if (!res.ok) throw notFound()
  return res.data
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
              a page: the component, <code>meta</code>
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
        <code>{'"rootDirs": [".", "./.nifra/types"]'}</code>.
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
          page, <code>frontend/</code> or <code>shared/</code> fails the build.
        </li>
        <li>
          <b>The build scans what it emits.</b> A client bundle, a public file or a prerendered page
          that contains what looks like a credential fails the build.
        </li>
      </ul>
      <p>
        The same rules run in <code>nifra dev</code> (a refused module is answered with a 403 before
        its source is sent), in both bundlers, for every framework, and in <code>nifra check</code>.
        An app on the older layout moves with <code>nifra migrate layout</code>: a dry run that
        reports every move, then <code>--write</code>.
      </p>
    </div>
  )
}
