import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/custom-server",
  "Nifra - Custom server (createWebApp)",
  "Run a page app from your own server entry with createWebApp: static and hashed files, a strict CSP on nifra's nonce, middleware order, loader error logging, graceful shutdown, and nifra check settings.",
)

const FULL_APP = `import { fileURLToPath } from "node:url"
import { createCspPolicy, createWebApp, servePublicDir } from "@nifrajs/web"
import type { Manifest, RenderAdapter } from "@nifrajs/web"

// From your build: the framework adapter, the route manifest, and what buildClient() returned.
declare const adapter: RenderAdapter
declare const manifest: Manifest
declare const build: {
  readonly entry: string
  readonly assets: readonly string[]
  readonly routes: Readonly<Record<string, readonly string[]>>
  readonly css?: readonly string[]
}
declare const errors: { capture(error: unknown, tags: Record<string, string>): void }

// buildClient({ outDir: "dist/assets" }) writes the chunks where their /assets/ URLs point.
const bundle = servePublicDir({
  dir: fileURLToPath(new URL("./dist/", import.meta.url)),
  hashedFiles: new Set(build.assets),
})
const publicFiles = servePublicDir({ dir: fileURLToPath(new URL("./public/", import.meta.url)) })

const csp = createCspPolicy({
  header: ({ sources }) => \`default-src 'self'; script-src 'self' \${sources}; object-src 'none'\`,
})

export const app = createWebApp({
  adapter,
  manifest,
  clientEntry: build.entry,
  routePreload: build.routes,
  styles: build.css ?? [],
  csp,
  server: { requestTimeoutMs: 15_000, gracefulSignals: { drainMs: 8_000 } },
  use: (app) => {
    app.onRequest(async (request) => (await bundle(request)) ?? (await publicFiles(request)))
  },
  onLoaderError: (error, { route }) => errors.capture(error, { route }),
})

app.listen(3000)`

const MIDDLEWARE = `// doc-check: skip - fragment: the use option of the createWebApp call above; @nifrajs/middleware is not installed in the docs sandbox.
import { requestId, securityHeaders } from "@nifrajs/middleware"

createWebApp({
  // ...
  use: (app) => {
    app.use(securityHeaders())
    app.use(requestId())
  },
})`

const NODE_SERVE = `// doc-check: skip - fragment: app and build are the createWebApp app and buildClient() output above.
import { serve } from "@nifrajs/node"

await serve(app, {
  port: 3000,
  static: { dir: new URL("./dist/assets/", import.meta.url), hashedFiles: build.assets },
  signals: { drainMs: 8_000 },
})`

const REFLECT = `// doc-check: skip - fragment: an app module's Redis client; ioredis is not installed in the docs sandbox.
import Redis from "ioredis"

// Unset when the app really runs; "check", "routes", "assure", ... while nifra only reads it.
export const redis = process.env.NIFRA_REFLECT ? undefined : new Redis(process.env.REDIS_URL!)`

const CHECK_CONFIG = `{
  "externalMounts": ["/api/auth"]
}`

const SINGLE_COPY = `{
  "name": "my-app",
  "nifra": { "singleCopy": ["@nifrajs/*", "react", "react-dom"] }
}`

export default function CustomServer() {
  return (
    <div className="prose">
      <h1 className="page">Custom server (createWebApp)</h1>
      <p className="lead">
        The standard project layout gets its server entry from <code>nifra build</code>. An app that
        calls <code>createWebApp</code> from its own entry wires the same pieces by hand. Each one is an
        option or a single call.
      </p>

      <h2>A complete entry</h2>
      <p>
        Everything on this page in one file. The sections below explain each part. This file
        typechecks against the current packages.
      </p>
      <CodeBlock code={FULL_APP} />

      <h2>Static and hashed files</h2>
      <p>
        <code>servePublicDir</code> from <code>@nifrajs/web</code> serves a directory on Bun, Node and
        Deno. It answers <code>GET</code> and <code>HEAD</code> only, refuses paths that leave the
        directory or name a hidden file, sets the content type and <code>nosniff</code>, handles range
        requests, and returns <code>undefined</code> on a miss so the request falls through to your
        routes.
      </p>
      <ul>
        <li>
          <b>Hashed build output.</b> Pass <code>buildClient()</code>'s <code>assets</code> as{" "}
          <code>hashedFiles</code>: those files get <code>immutable</code> for a year, and anything
          else in the directory gets one day. Write the build to <code>outDir: "dist/assets"</code> so
          a chunk's <code>/assets/...</code> URL is also its path under <code>dist/</code>.
        </li>
        <li>
          <b>Your own files.</b> A second handler on <code>public/</code> serves them at the root,
          with the one-day policy.
        </li>
        <li>
          <b>Where it runs.</b> Register the handlers with <code>app.onRequest</code> inside{" "}
          <code>use</code>, so a static hit never reaches page rendering.
        </li>
      </ul>
      <p>
        On Node, <code>serve()</code> from <code>@nifrajs/node</code> can serve the bundle itself before
        the app runs, which keeps the direct request path for everything else:
      </p>
      <CodeBlock code={NODE_SERVE} />

      <h2>A strict CSP on nifra's nonce</h2>
      <p>
        Pass <code>createCspPolicy</code> as <code>csp</code> and nifra writes the{" "}
        <code>Content-Security-Policy</code> header for each document. You do not stash a nonce or set
        the header yourself. Your <code>header</code> function receives <code>sources</code>: a hash
        for each constant inline script nifra writes, plus a nonce only when the document carries a
        request-specific script (a <code>defer()</code>ed value, or <code>unsafeInlineScript</code> in{" "}
        <code>meta</code>).
      </p>
      <p>
        A document without a nonce gets the same header on every request, so it can still be cached by{" "}
        <code>withISR</code> or a CDN. A document with a nonce is sent <code>private, no-store</code>.
        The older <code>nonce</code> option puts a nonce on every document, so nothing is cacheable.{" "}
        <code>createWebApp</code> refuses <code>csp</code> and <code>nonce</code> together.
      </p>

      <h2>Middleware goes in use</h2>
      <p>
        <code>createWebApp</code> declares every page route, and the <code>/*</code> catch-all, before
        it returns. <code>beforeHandle</code>, <code>afterHandle</code>, <code>around</code>,{" "}
        <code>derive</code>, <code>decorate</code> and <code>onError</code> are copied into each route
        when the route is declared. One of those hooks added to the returned app would therefore reach
        no page. <code>requestId()</code> is a <code>derive</code>: added late, no page would see{" "}
        <code>c.requestId</code>. Outside production, adding one throws a <code>FrameworkError</code>{" "}
        with code <code>HOOK_AFTER_PAGES</code> that names the call site. Hooks added inside{" "}
        <code>app.group(prefix, ...)</code> are still allowed, because a group is its own scope.
      </p>
      <p>
        Apply middleware in the <code>use</code> option instead. It runs before any page is declared,
        and ahead of <code>mounts</code> and the <code>api</code> mount, so an <code>onRequest</code>{" "}
        guard also covers a mounted auth handler:
      </p>
      <CodeBlock code={MIDDLEWARE} />
      <p>
        <code>onRequest</code> and <code>onResponse</code> are read per request, so those two still
        work when added late. Putting everything in <code>use</code> means you never need to remember
        which hooks those are.
      </p>
      <p>
        A plugin applied in <code>use</code> works at runtime but cannot add to the returned app's type.
        To get <code>c.requestId</code> typed on routes you declare afterwards, call{" "}
        <code>app.use(requestId())</code> again on the returned app. Named plugins apply once.
      </p>

      <h2>Loader errors</h2>
      <p>
        When a loader or action throws and an <code>_error</code> boundary renders the page, the error
        is written to the server's <code>logger</code>, at the detail set by{" "}
        <code>server.errorLogDetail</code>. That is the same log line an unhandled 500 produces, and you
        do not need to configure anything for it. A soft-navigation data request that fails is logged
        the same way. A thrown <code>Response</code>, such as <code>redirect()</code>, is not an
        error and is not logged.
      </p>
      <p>
        <code>onLoaderError</code> is for an error reporter. It sees every real throw with the request,
        params and route id before the boundary renders. If it throws, the error is ignored so rendering
        continues.
      </p>

      <h2>Graceful shutdown</h2>
      <p>
        On Bun, <code>server: {"{ gracefulSignals: { drainMs } }"}</code> makes <code>listen()</code>{" "}
        handle <code>SIGTERM</code> and <code>SIGINT</code>. The server gives in-flight requests up
        to <code>drainMs</code> (default 10 000) to finish, then stops, closing any that are still
        running. On Bun, new connections can still arrive during that window, so the load balancer
        should stop routing to the instance first, as most platforms do before they send{" "}
        <code>SIGTERM</code>. Keep <code>drainMs</code> under your platform's kill grace period:{" "}
        <code>docker stop</code> waits 10 seconds. <code>true</code> uses the default. On Node and
        Deno, pass{" "}
        <code>signals: {"{ drainMs }"}</code> to <code>serve()</code> instead, as above.
      </p>

      <h2>Letting check and assure read the app</h2>
      <p>
        <code>nifra check</code>, <code>assure</code>, <code>routes</code> and the other commands that
        read the app import it, so everything the app does at module scope runs. A command that only
        reads what the app declares sets <code>NIFRA_REFLECT</code> to its own name first:{" "}
        <code>check</code>, <code>routes</code>, <code>context</code>, <code>openapi</code>,{" "}
        <code>contracts</code>, <code>capabilities</code>, <code>manifest</code>, <code>doctor</code>
        , <code>diff</code>, <code>sync-routes</code>, <code>sync-manifest</code>, and{" "}
        <code>assure</code> without <code>--bundle</code>, <code>--strict</code>,{" "}
        <code>--hydration</code>, <code>--interact</code> or <code>--out</code>. Commands that send the
        app requests, such as <code>smoke</code>, <code>prove</code>, <code>levels</code> and the{" "}
        <code>assure</code> bundle, leave it unset. Check it to skip work a read never needs:
      </p>
      <CodeBlock code={REFLECT} />
      <ul>
        <li>
          <b>Environment validation.</b> An app that validates its environment on import still needs
          values to pass it. Supply them with <code>--env-file</code>, for example{" "}
          <code>nifra check --env-file .env.example</code>. Variables already set in the shell win.
        </li>
        <li>
          <b>A process that will not exit.</b> If something the app opened is still keeping the process
          alive 2 seconds after the command has answered, the command exits with its own result and
          says that the app kept it open.
        </li>
      </ul>

      <h2>nifra check for a custom entry</h2>
      <ul>
        <li>
          <b>Routes nifra cannot see.</b> A mounted handler such as better-auth answers paths that are
          not in your backend, and no typed client covers them. Declare the mount opaque,{" "}
          <code>
            mounts: [{"{"} path: "/api/auth", app: auth, opaque: "better-auth" {"}"}]
          </code>
          , and when <code>nifra.assurance.ts</code> names this app as its <code>source</code>, the
          check skips a <code>fetch</code> into that prefix by itself. Without that, list the prefixes
          in <code>nifra.check.json</code> next to <code>package.json</code>:
        </li>
      </ul>
      <CodeBlock code={CHECK_CONFIG} />
      <ul>
        <li>
          <b>Two repositories, one runtime.</b> When a linked sibling repository brings its own install
          of nifra or React, <code>nifra check</code> reports the duplicates. A reinstall in this app
          cannot remove a copy that another project installed. Declare the packages single-copy and
          nifra loads this app's copy for every importer:
        </li>
      </ul>
      <CodeBlock code={SINGLE_COPY} />
      <p>
        Packages duplicated the same way are reported as one finding with one combined{" "}
        <code>singleCopy</code> list. The preload this needs, and the version-skew case it cannot
        cover, are in <a href="/docs/troubleshooting">Troubleshooting</a>.
      </p>
    </div>
  )
}
