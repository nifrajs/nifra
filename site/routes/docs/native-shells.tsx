import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/native-shells",
  "Nifra - Native shells",
  "Ship an app's pages inside Tauri, Capacitor or Electron while its server stays on the web: one transport for route data, actions, server functions and the live socket.",
)

const BASE_TRANSPORT = `// frontend/transport.ts
import { serverFetch } from "@nifrajs/web/shell"

export default serverFetch({ origin: "https://api.example.com" })`

const TRANSPORT = `// frontend/transport.ts
import { serverFetch } from "@nifrajs/web/shell"

export default serverFetch({
  origin: "https://api.example.com",
  // A bearer token that refreshes: the function runs before each request.
  headers: async () => ({ authorization: \`Bearer \${await currentToken()}\` }),
})

// The app's own: where it keeps and refreshes its token.
declare function currentToken(): Promise<string>`

const COOKIES = `// doc-check: skip - a fragment of frontend/transport.ts.
export default serverFetch({ origin: "https://api.example.com", credentials: "include" })`

const CONFIG = `// doc-check: skip - nifra.config.ts for the CLI; the adapter is the app's own.
// Only for an app that ships nothing but the shell: it applies to every build.
export { adapter } from "./backend/framework"
export const clientModule = "@nifrajs/web-react/client"
export const transport = "./frontend/transport.ts"`

const BUILD = `nifra build --target static --out dist --prerender /`

const SCAFFOLD = `nifra shell tauri --origin https://api.example.com`

const NEW_APP = `bun create nifra my-app --shell tauri
cd my-app && bun install
bunx tauri icon path/to/icon.png   # a square PNG, 1024x1024 recommended
bun run shell:dev`

const TAURI_BUILD = `bun add -d @tauri-apps/cli
bunx tauri icon path/to/icon.png   # a square PNG, 1024x1024 recommended
bunx tauri dev`

const TAURI = `// doc-check: skip - src-tauri/tauri.conf.json
{
  "build": { "frontendDist": "../dist-shell" },
  "app": { "security": { "csp": "default-src 'self'; connect-src 'self' https://api.example.com wss://api.example.com" } }
}`

const MOBILE = `nifra shell tauri --mobile android   # or ios, or all`

const TRANSPORT_FLAG = `nifra build --target static --out dist-shell --transport ./frontend/shell-transport.ts --prerender /`

const QUERY = `import { appFetch } from "@nifrajs/web/shell"

// The transport in a shell build, the global fetch anywhere else.
export const todos = (): Promise<unknown> => appFetch("/api/todos").then((res) => res.json())`

const SERVER = `// backend/framework.ts: the web app answers page data and form posts, so the CORS goes on it.
import { cors } from "@nifrajs/middleware"

const SHELLS = ["tauri://localhost", "http://tauri.localhost", "capacitor://localhost"]

export const use = (app: { use: (plugin: ReturnType<typeof cors>) => unknown }): void => {
  app.use(
    cors({
      origin: SHELLS,
      // Named, not "*": a credentialed request reads "*" as a header called "*".
      exposedHeaders: ["x-nifra-redirect", "x-nifra-status", "x-nifra-revalidate"],
    }),
  )
}`

const ACTIONS = `// doc-check: skip - a route's backend half; the action is the app's own.
// routes/todos.backend.ts
// allowedOrigins replaces the same-origin default, so the site's own posts come in as sameOrigin.
const SHELLS = ["tauri://localhost", "http://tauri.localhost", "capacitor://localhost"]

export const allowedOrigins = (origin: string | null, sameOrigin: boolean): boolean =>
  sameOrigin || (origin !== null && SHELLS.includes(origin))`

const FUNCTIONS = `import { serverFunctions } from "@nifrajs/web/fn"
import * as todos from "./todos.fn.ts"

export const fns = serverFunctions("todos", todos, {
  origins: ["tauri://localhost", "http://tauri.localhost", "capacitor://localhost"],
})`

const LIVE = `import { live } from "@nifrajs/web/live"

export const runtime = live({
  secret: process.env.LIVE_SECRET ?? "",
  // Anonymous viewers. An app with accounts returns the session's user id, so a change of account
  // clears the client's cache and revoke(userId) reaches this viewer's grants.
  subject: () => null,
  trustedOrigins: ["tauri://localhost", "http://tauri.localhost", "capacitor://localhost"],
})`

export default function NativeShells() {
  return (
    <article>
      <h1>Native shells</h1>
      <p>
        A shell wraps an app's pages in a native window or a phone app: Tauri, Capacitor and
        Electron all load the built client from disk. The pages then live on one origin, such as{" "}
        <code>tauri://localhost</code>, and the server on another. A <code>transport</code> tells
        the client where the server is. The router's requests, server functions, the live socket and
        the calls you make with <code>appFetch</code> go through it; a plain{" "}
        <code>fetch(&quot;/api/todos&quot;)</code> does not, and goes to the shell's own origin.
      </p>
      <h2 id="build">Build the pages</h2>
      <p>
        Write the transport in a frontend file with <code>serverFetch</code> from{" "}
        <code>@nifrajs/web/shell</code>. A path-absolute URL, such as <code>/todos</code>, goes to{" "}
        <code>origin</code>. The headers are added to each request to that origin, and may be a
        function that returns them; a request to any other host goes out as written, without the
        headers or credentials, so a call to a third party never carries your token.
      </p>
      <CodeBlock code={BASE_TRANSPORT} lang="ts" />
      <p>With a token that refreshes:</p>
      <CodeBlock code={TRANSPORT} lang="ts" />
      <p>
        An app that signs in with a cookie sets <code>credentials: &quot;include&quot;</code>. The
        server then needs <code>credentials: true</code> in its CORS options and a cookie a
        cross-site request may carry (<code>SameSite=None; Secure</code>), and a web view may
        restrict cookies further, so a bearer token is the safer choice in a shell.
      </p>
      <CodeBlock code={COOKIES} lang="ts" />
      <p>
        Pass the module to the shell build with <code>--transport</code>, and name the pages the
        shell opens on with{" "}
        <code>--prerender</code> (comma-separated paths such as <code>/,/about</code>). Only this
        build prerenders them, so a web build of the same app keeps rendering them per request; a
        route that exports <code>prerender = true</code> is included too. A path that is not a
        static page route fails the build.
      </p>
      <CodeBlock code={BUILD} lang="bash" />
      <p>
        <code>transport</code> in the framework config does the same for an app that ships nothing
        but the shell. It applies to every build, and <code>--transport</code> replaces it but
        cannot turn it off, so leave it out of an app that also ships a web build.
      </p>
      <CodeBlock code={CONFIG} lang="ts" />
      <p>
        The output has an <code>index.html</code> for each prerendered route and the assets they
        load, which is what a shell's <code>frontendDist</code> points at. The same option reaches
        the Bun and Vite builds and both dev servers, and <code>buildClient</code> takes it as{" "}
        <code>transport</code>.
      </p>
      <p>
        A path the shell has no page for, such as a reload at <code>/todos</code>, hydrates the
        document the shell ships and then navigates to that URL. A prerendered page's route data
        loads from the bundle, except a navigation with a query string and, in an app with{" "}
        <code>live</code>, the loads the live endpoint makes: those go to the server.
      </p>
      <p>
        <code>--transport</code> names the module for one run and wins over the config, so an app
        can ship a web build and a shell build from one tree. <code>--prerender</code> only
        applies to <code>--target static</code>:
      </p>
      <CodeBlock code={TRANSPORT_FLAG} lang="bash" />
      <h2 id="requests">What goes through the transport</h2>
      <ul>
        <li>Route data, prefetches and action posts of the router.</li>
        <li>
          <a href={href({ to: "/docs/api" })}>Server functions</a>: the stub that stands in for a{" "}
          <code>*.fn.ts</code> module calls through it.
        </li>
        <li>
          The <a href={href({ to: "/docs/live" })}>live</a> socket and its load endpoint. The
          socket connects to the transport's origin.
        </li>
        <li>
          <a href={href({ to: "/docs/keep-alive" })}>Keep-alive</a> pages, layered over the
          transport.
        </li>
        <li>
          Your own calls, with <code>appFetch</code>. Hand it to a <code>useQuery</code> fetcher or
          to the typed client: <code>client(url, {"{ fetch: appFetch }"})</code>.
        </li>
      </ul>
      <CodeBlock code={QUERY} lang="ts" />
      <h2 id="server">Let the server accept the shell</h2>
      <p>
        A shell's requests carry its own scheme as their <code>Origin</code>, so the server refuses
        them until it lists that origin. Tauri uses <code>tauri://localhost</code> on macOS, iOS
        and Linux and <code>http://tauri.localhost</code> on Windows and Android; Capacitor uses{" "}
        <code>capacitor://localhost</code> on iOS.
      </p>
      <ul>
        <li>
          CORS on the web app, as the <code>use</code> hook of <code>backend/framework.ts</code>:
          page data and form posts are its routes, not the backend's. List the headers the router
          reads in <code>exposedHeaders</code>; <code>"*"</code> is read literally by a credentialed
          request.
        </li>
        <li>
          A page action checks the route's own <code>allowedOrigins</code>, which replaces the
          same-origin default. Its second argument says whether that default would admit the
          request, so a route can keep its own site and add the shell.
        </li>
        <li>
          <code>serverFunctions</code> takes <code>origins</code>.
        </li>
        <li>
          <code>live</code> takes <code>trustedOrigins</code>, for the load endpoint and the
          socket.
        </li>
      </ul>
      <CodeBlock code={SERVER} lang="ts" />
      <CodeBlock code={ACTIONS} lang="ts" />
      <CodeBlock code={FUNCTIONS} lang="ts" />
      <CodeBlock code={LIVE} lang="ts" />
      <h2 id="tauri">Tauri 2</h2>
      <p>
        <code>nifra shell tauri</code> adds the transport and a <code>src-tauri/</code> project to
        an existing app. It writes files only, skips any that exist unless <code>--force</code>,
        and leaves <code>package.json</code> and the config alone. The project builds the static
        target with <code>--transport</code> into <code>dist-shell/</code>, and its content
        security policy allows the server's origin and socket. The window opens hidden and shows
        on the page's first paint, with a three second timer as the fallback, so there is no blank
        window while the web view starts.
      </p>
      <CodeBlock code={SCAFFOLD} lang="bash" />
      <CodeBlock code={TAURI_BUILD} lang="bash" />
      <p>
        A new site can start with a shell: <code>--shell tauri</code> adds the same project, lets
        the server's CORS accept the shell origins in <code>backend/shell-origins.ts</code>, and
        adds <code>shell:dev</code> and <code>shell:build</code> scripts.
      </p>
      <CodeBlock code={NEW_APP} lang="bash" />
      <p>
        <code>--mobile</code> also runs <code>tauri android init</code> or{" "}
        <code>tauri ios init</code> with the project&apos;s Tauri CLI, which needs the platform
        toolchain: the Android SDK and NDK, or Xcode. A platform that fails is reported and the
        files already written stay.
      </p>
      <CodeBlock code={MOBILE} lang="bash" />
      <p>
        By hand, point <code>frontendDist</code> at the build and allow the server in the content
        security policy. On iOS, a development server on a local address needs{" "}
        <code>NSAllowsLocalNetworking</code> in the app's <code>Info.plist</code>.
      </p>
      <CodeBlock code={TAURI} lang="json" />
      <h2 id="limits">Limits</h2>
      <ul>
        <li>
          The transport module must sit in a zone: <code>frontend/</code>, or a package that
          declares <code>"nifra": {"{ \"environment\": \"frontend\" }"}</code>.
        </li>
        <li>
          Tauri on macOS, the iOS Simulator and an Android emulator are what this was run on.
          Windows and Linux use the same transport but have not been run.
        </li>
        <li>
          On Android the web view draws under the status bar, so a page that starts at the top
          needs its own top padding.
        </li>
        <li>
          A page in a shell starts in the system web view, so its first paint comes after the
          view does.
        </li>
      </ul>
    </article>
  )
}
