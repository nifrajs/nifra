import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/native-shells",
  "Nifra - Native shells",
  "Ship an app's pages inside Tauri, Capacitor or Electron while its server stays on the web: one transport for route data, actions, server functions and the live socket.",
)

const TRANSPORT = `// frontend/transport.ts
import { serverFetch } from "@nifrajs/web/shell"

export default serverFetch({
  origin: "https://api.example.com",
  // A bearer token that refreshes: the function runs before each request.
  headers: async () => ({ authorization: \`Bearer \${await currentToken()}\` }),
})

declare function currentToken(): Promise<string>`

const CONFIG = `// doc-check: skip - nifra.config.ts for the CLI; the adapter is the app's own.
export { adapter } from "./backend/framework"
export const clientModule = "@nifrajs/web-react/client"
export const transport = "./frontend/transport.ts"`

const PRERENDER = `// routes/index.backend.ts
export const prerender = true`

const BUILD = `nifra build --target static --out dist`

const SCAFFOLD = `nifra shell tauri --origin https://api.example.com`

const NEW_APP = `bun create nifra my-app --shell tauri
cd my-app && bun install
bunx tauri icon app-icon.png
bun run shell:dev`

const TAURI_BUILD = `bun add -d @tauri-apps/cli
bunx tauri icon app-icon.png
bunx tauri dev`

const MOBILE = `nifra shell tauri --mobile android   # or ios, or all`

const TRANSPORT_FLAG = `nifra build --target static --out dist-shell --transport ./frontend/shell-transport.ts`

const QUERY = `import { appFetch } from "@nifrajs/web/shell"

// The transport in a shell build, the global fetch anywhere else.
export const todos = (): Promise<unknown> => appFetch("/api/todos").then((res) => res.json())`

const SERVER = `import { cors } from "@nifrajs/middleware"
import { server } from "@nifrajs/core"

const SHELLS = ["tauri://localhost", "http://tauri.localhost", "capacitor://localhost"]

export const app = server().use(
  cors({ origin: SHELLS, exposedHeaders: ["*"], credentials: true }),
)`

const ACTIONS = `// doc-check: skip - a route's backend half; the action is the app's own.
// routes/todos.backend.ts
export const allowedOrigins = ["tauri://localhost", "http://tauri.localhost"]`

const FUNCTIONS = `import { serverFunctions } from "@nifrajs/web/fn"
import * as todos from "./todos.fn.ts"

export const fns = serverFunctions("todos", todos, {
  origins: ["tauri://localhost", "http://tauri.localhost"],
})`

const LIVE = `import { live } from "@nifrajs/web/live"

export const runtime = live({
  secret: process.env.LIVE_SECRET ?? "",
  subject: () => null,
  trustedOrigins: ["tauri://localhost", "http://tauri.localhost"],
})`

const TAURI = `// doc-check: skip - src-tauri/tauri.conf.json
{
  "build": { "frontendDist": "../dist" },
  "app": { "security": { "csp": "default-src 'self'; connect-src 'self' https://api.example.com wss://api.example.com" } }
}`

export default function NativeShells() {
  return (
    <article>
      <h1>Native shells</h1>
      <p>
        A shell wraps an app's pages in a native window or a phone app: Tauri, Capacitor and
        Electron all load the built client from disk. The pages then live on one origin, such as{" "}
        <code>tauri://localhost</code>, and the server on another. A <code>transport</code> tells
        the client where the server is, and every request the app makes goes through it.
      </p>
      <h2 id="build">Build the pages</h2>
      <p>
        Write the transport in a frontend file with <code>serverFetch</code> from{" "}
        <code>@nifrajs/web/shell</code>. A path-absolute URL, such as <code>/todos</code>, goes to{" "}
        <code>origin</code>. The headers are added to each request, and may be a function that
        returns them.
      </p>
      <CodeBlock code={TRANSPORT} lang="ts" />
      <p>Name the module in the framework config and build the static target:</p>
      <CodeBlock code={CONFIG} lang="ts" />
      <CodeBlock code={PRERENDER} lang="ts" />
      <CodeBlock code={BUILD} lang="bash" />
      <p>
        The output has an <code>index.html</code> for each prerendered route and the assets they
        load, which is what a shell's <code>frontendDist</code> points at. The same option reaches
        the Bun and Vite builds and both dev servers, and <code>buildClient</code> takes it as{" "}
        <code>transport</code>.
      </p>
      <p>
        A path the shell has no page for, such as a reload at <code>/todos</code>, hydrates the
        document the shell ships and then navigates to that URL. Route data for prerendered pages
        loads from the bundle; everything else goes to the server.
      </p>
      <p>
        <code>--transport</code> names the module for one run and wins over the config, so an app
        can ship a web build and a shell build from one tree:
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
          CORS, with <code>exposedHeaders: ["*"]</code>. Without it the page cannot read the
          status or redirect headers of its own responses. A named CORS origin also admits that
          origin's form posts.
        </li>
        <li>
          A page action checks the route's own <code>allowedOrigins</code>.
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
