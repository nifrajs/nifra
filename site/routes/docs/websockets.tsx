import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no interactivity, so ship zero framework JS.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — WebSockets",
  "app.ws(path, handler) registers a typed WebSocket route — an upgrade guard, a portable socket, contract-validated messages, and topic pub/sub — served on Bun, Deno, Node, and Cloudflare Workers.",
)

const BASIC = `import { server } from "@nifrajs/core/server"
import "@nifrajs/core/ws" // registers the WebSocket runtime app.ws() needs

const app = server()
  .get("/", () => ({ ok: true }))
  .ws("/echo", {
    open: (ws) => ws.send("welcome"),
    message: (ws, data) => ws.send(data), // data: string | Uint8Array
  })

app.listen(3000) // Bun`

const LIFECYCLE = `// doc-check: skip — illustrative lifecycle (empty close/error bodies, cookie shape).
app.ws<{ user: string }>("/chat", {
  // upgrade(c) runs in the full HTTP request context, BEFORE the socket opens —
  // authenticate, check origin, rate-limit. Return the per-connection data (→ ws.data,
  // typed), or a Response to REJECT the upgrade. A thrown error rejects with 500.
  upgrade(c) {
    const user = c.cookies.session
    if (user === undefined) return new Response("unauthorized", { status: 401 })
    return { user }
  },
  open: (ws) => ws.send(\`welcome \${ws.data.user}\`), // ws.data is { user: string }
  message: (ws, data) => ws.send(data),              // string | Uint8Array, normalized
  close: (ws, code, reason) => {},
  error: (ws, err) => {}, // a throw in any callback routes here, never crashing the connection
})`

const SCHEMA = `// doc-check: skip — illustrative: validated inbound frames on an existing app.
import { t } from "@nifrajs/schema"

app.ws("/chat", {
  messageSchema: t.Object({ kind: t.Literal("say"), text: t.String({ maxLength: 500 }) }),
  message(ws, msg) {
    // msg is typed { kind: "say"; text: string } — already parsed + validated.
    app.publish("room", msg.text)
  },
  onInvalidMessage(ws, issues) {
    ws.send(JSON.stringify({ error: "bad message", issues }))
  },
})`

const PUBSUB = `// doc-check: skip — illustrative pub/sub on an existing app.
app.ws("/room/:id", {
  open: (ws) => ws.subscribe("room"),
  message: (ws, text) => app.publish("room", text), // fan out to all subscribers
})`

const WORKERS = `// doc-check: skip — Workers entry: a Durable Object hub holds the connections.
import { createWebSocketHub, toFetchHandler } from "@nifrajs/workers"

export const NifraWebSocketHub = createWebSocketHub(app) // bind as NIFRA_WS_HUB in wrangler.toml
export default toFetchHandler(app, { webSocketHub: (env) => env.NIFRA_WS_HUB })`

const NODE_WS = `npm i ws`

export default function WebSockets() {
  return (
    <div className="prose">
      <h1 className="page">WebSockets</h1>
      <p className="lead">
        <code>app.ws(path, handler)</code> registers a WebSocket route. It mirrors{" "}
        <code>.get()</code>/<code>.post()</code> — chainable, with per-connection state typed
        through a generic — and runs on every runtime nifra serves: Bun, Deno, Node, and Cloudflare
        Workers.
      </p>
      <p>
        The WebSocket runtime ships as a subpath, so apps that never use it don’t bundle it. Import
        it once at your server entry; <code>app.ws()</code> without it fails loud at boot with{" "}
        <code>WS_RUNTIME_MISSING</code>. (<code>@nifrajs/workers</code> imports it for you.)
      </p>
      <CodeBlock code={BASIC} />

      <h2>Lifecycle</h2>
      <p>
        Every callback is optional — <code>{"{ message }"}</code> alone is a valid echo server.{" "}
        <code>upgrade</code> is the only one that runs before the socket opens, so it’s the one place
        to reject a connection.
      </p>
      <CodeBlock code={LIFECYCLE} />

      <h2>NifraWebSocket</h2>
      <p>
        The <code>ws</code> handed to each callback is a portable wrapper over the runtime’s native
        socket:
      </p>
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>send(data)</code>
            </td>
            <td>
              text (<code>string</code>) or binary (<code>ArrayBuffer</code>/typed-array)
            </td>
          </tr>
          <tr>
            <td>
              <code>close(code?, reason?)</code>
            </td>
            <td>close the connection</td>
          </tr>
          <tr>
            <td>
              <code>readyState</code>
            </td>
            <td>
              <code>0</code> CONNECTING · <code>1</code> OPEN · <code>2</code> CLOSING · <code>3</code>{" "}
              CLOSED
            </td>
          </tr>
          <tr>
            <td>
              <code>subscribe(topic)</code> / <code>unsubscribe(topic)</code>
            </td>
            <td>pub/sub (below)</td>
          </tr>
          <tr>
            <td>
              <code>data</code>
            </td>
            <td>per-connection state, seeded by <code>upgrade()</code>, mutable</td>
          </tr>
          <tr>
            <td>
              <code>raw</code>
            </td>
            <td>escape hatch to the native socket</td>
          </tr>
        </tbody>
      </table>

      <h2>Contract-validated messages</h2>
      <p>
        Inbound frames arrive raw (<code>string | Uint8Array</code>) by default. Add a{" "}
        <code>messageSchema</code> — any{" "}
        <a href="https://standardschema.dev">Standard Schema</a> (<code>t</code>, zod, valibot) — and
        nifra parses each frame as JSON, validates it, and hands <code>message</code> the typed
        value; anything that fails goes to <code>onInvalidMessage</code> instead (so a malformed
        frame can never reach your handler).
      </p>
      <CodeBlock code={SCHEMA} />

      <h2>Pub/sub — app.publish</h2>
      <p>
        <code>ws.subscribe(topic)</code> joins a topic; <code>app.publish(topic, data)</code>{" "}
        broadcasts to everyone in it. Subscriptions drop automatically when a connection closes.
      </p>
      <CodeBlock code={PUBSUB} />
      <p>
        Bun, Deno, and Node are long-lived processes, so this works directly on a single instance.
        Across a load balancer, <code>app.publish</code> only reaches sockets on the same instance —
        bridge an external fan-out (Redis pub/sub, NATS, a queue) to broadcast across all of them. On{" "}
        <strong>Cloudflare Workers</strong>, a stateless isolate can’t broadcast across connections,
        so nifra ships a Durable Object hub: <code>createWebSocketHub(app)</code> holds the
        connections, and <code>toFetchHandler(app, {"{ webSocketHub }"})</code> routes upgrades to it
        — then <code>ws.subscribe</code> / <code>app.publish</code> behave exactly as on Bun.
      </p>
      <CodeBlock code={WORKERS} />

      <h2>Serving — adapter-integrated, not app.fetch</h2>
      <p>
        A WebSocket upgrade can’t go through <code>app.fetch(Request)</code> — it needs the live
        socket, which only the runtime’s serving layer holds. So WS is wired by each serving entry;{" "}
        <code>app.ws()</code> and the handler are identical everywhere.
      </p>
      <table>
        <thead>
          <tr>
            <th>Runtime</th>
            <th>Serve with</th>
            <th>Upgrade primitive</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Bun</td>
            <td>
              <code>app.listen(port)</code>
            </td>
            <td>
              <code>Bun.serve</code> <code>server.upgrade</code> + <code>websocket</code> config
            </td>
          </tr>
          <tr>
            <td>Deno</td>
            <td>
              <code>serve(app, …)</code> from <code>@nifrajs/deno</code>
            </td>
            <td>
              <code>Deno.upgradeWebSocket</code>
            </td>
          </tr>
          <tr>
            <td>Node</td>
            <td>
              <code>serve(app, …)</code> from <code>@nifrajs/node</code>
            </td>
            <td>
              the <code>upgrade</code> event + the optional <code>ws</code> package
            </td>
          </tr>
          <tr>
            <td>Cloudflare Workers</td>
            <td>
              <code>export default toFetchHandler(app)</code>
            </td>
            <td>
              <code>WebSocketPair</code> + a <code>101</code> response
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Node has no built-in WebSocket server, so <code>@nifrajs/node</code> uses <code>ws</code> — an
        optional peer dependency, lazy-imported on the first upgrade (a non-WS Node app never loads
        it). Install it when you use <code>app.ws()</code>; without it a WS upgrade gets a clean{" "}
        <code>501</code> and the HTTP routes are unaffected.
      </p>
      <CodeBlock code={NODE_WS} />
    </div>
  )
}
