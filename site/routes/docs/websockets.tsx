import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/websockets",
  "Nifra - WebSockets",
  "app.ws(path, handler) registers a typed WebSocket route - an upgrade guard, a portable socket, contract-validated messages, and topic pub/sub - served on Bun, Deno, Node, and Cloudflare Workers.",
)

const BASIC = `import { server } from "@nifrajs/core/server"
import { websocket } from "@nifrajs/core/ws" // .use(websocket()) enables app.ws()

const app = server()
  .use(websocket())
  .get("/", () => ({ ok: true }))
  .ws("/echo", {
    open: (ws) => ws.send("welcome"),
    message: (ws, data) => ws.send(data), // data: string | Uint8Array
  })

app.listen(3000) // Bun`

const LIFECYCLE = `// doc-check: skip - illustrative lifecycle (empty close/error bodies, cookie shape).
app.ws<{ user: string }>("/chat", {
  // upgrade(c) runs in the full HTTP request context, BEFORE the socket opens, after the
  // guards registered before this route. Return the per-connection data (→ ws.data, typed),
  // or a Response or status(...) to REJECT the upgrade. A thrown Response rejects with it;
  // any other throw goes to onError, then a 500.
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

const GUARDED = `// doc-check: skip - illustrative: an existing auth guard and session lookup.
app
  .ws("/status", {})                       // registered before the guard: public
  .authenticate(sessionAuth)               // or .use(basicAuth(...)), .derive(...), .beforeHandle(...)
  .get("/me", (c) => c.principal)
  .ws("/chat", {
    // Reached only when sessionAuth accepted the handshake, exactly as GET /me is.
    upgrade: (c) => ({ user: c.principal.id }),
  })`

const SCHEMA = `// doc-check: skip - illustrative: validated inbound frames on an existing app.
import { t } from "@nifrajs/schema"

app.ws("/chat", {
  messageSchema: t.object({ kind: t.literal("say"), text: t.string({ maxLength: 500 }) }),
  message(ws, msg) {
    // msg is typed { kind: "say"; text: string } - already parsed + validated.
    app.publish("room", msg.text)
  },
  onInvalidMessage(ws, issues) {
    ws.send(JSON.stringify({ error: "bad message", issues }))
  },
})`

const OUTBOUND = `// doc-check: skip - illustrative: outbound contract on an existing app.
import { t } from "@nifrajs/schema"

app.ws("/events", {
  sendSchema: t.object({ kind: t.literal("ready"), id: t.string() }),
  validateSend: true, // opt in; default remains type-level only
  open(ws) {
    ws.send(JSON.stringify({ kind: "ready", id: "evt-1" }))
  },
})`

const TYPED_MESSAGES = `import { client } from "@nifrajs/client"
import { type InferOutput, server } from "@nifrajs/core/server"
import { websocket } from "@nifrajs/core/ws"
import { t } from "@nifrajs/schema"

// The contract, in a module both sides import: one discriminated union per direction.
export const ChatIn = t.union([
  t.object({ type: t.literal("say"), text: t.string({ maxLength: 500 }) }),
  t.object({ type: t.literal("pong"), id: t.integer() }),
])
export const ChatOut = t.union([
  t.object({ type: t.literal("said"), from: t.string(), text: t.string() }),
  t.object({ type: t.literal("ping"), id: t.integer() }),
])
type ChatFrame = InferOutput<typeof ChatOut>

const frame = (value: ChatFrame): string => JSON.stringify(value)

// Server: a ping every 30 s; a connection that leaves two unanswered is closed.
const app = server()
  .use(websocket())
  .ws("/chat", {
    messageSchema: ChatIn,
    sendSchema: ChatOut,
    upgrade: (c) => ({
      user: c.cookies.user ?? "guest",
      unanswered: 0,
      timer: undefined as ReturnType<typeof setInterval> | undefined,
    }),
    open(ws) {
      ws.subscribe("room")
      let id = 0
      ws.data.timer = setInterval(() => {
        if (ws.data.unanswered >= 2) return ws.close(4000, "heartbeat timeout")
        ws.data.unanswered += 1
        ws.send(frame({ type: "ping", id: ++id }))
      }, 30_000)
    },
    message(ws, msg) {
      switch (msg.type) {
        case "say":
          app.publish("room", frame({ type: "said", from: ws.data.user, text: msg.text }))
          break
        case "pong":
          ws.data.unanswered = 0
          break
      }
    },
    close: (ws) => clearInterval(ws.data.timer),
  })

// Client: frames are typed from sendSchema, and checked against it with validateReceive.
export async function joinChat(baseUrl: string): Promise<void> {
  const chat = client<typeof app>(baseUrl).chat.ws({
    validateReceive: ChatOut,
    onError: (error) => console.warn(error),
  })
  for await (const msg of chat.messages()) {
    switch (msg.type) {
      case "said":
        console.log(\`\${msg.from}: \${msg.text}\`)
        break
      case "ping":
        chat.send({ type: "pong", id: msg.id }) // a frame the client must answer
        break
      default: {
        const unhandled: never = msg // a new ChatOut variant fails to compile here
        throw new Error(\`unhandled frame \${JSON.stringify(unhandled)}\`)
      }
    }
  }
}`

const PUBSUB = `// doc-check: skip - illustrative pub/sub on an existing app.
app.ws("/room/:id", {
  open: (ws) => ws.subscribe("room"),
  message: (ws, text) => app.publish("room", text), // fan out to all subscribers
})`

const WORKERS = `// doc-check: skip - Workers entry: a Durable Object hub holds the connections.
import { toFetchHandler } from "@nifrajs/core/server"
import { createWebSocketHub } from "@nifrajs/workers"

export const NifraWebSocketHub = createWebSocketHub(app) // bind as NIFRA_WS_HUB in wrangler.toml
export default toFetchHandler(app, { webSocketHub: (env) => env.NIFRA_WS_HUB })`

const NODE_WS = `npm i ws`

const COMPOSED = `// server.ts - one listener; the chat child and a non-nifra child both take upgrades.
import { server } from "@nifrajs/core/server"
import { attachWebSocket, TopicRegistry, websocket, type WebSocketUpgradeOutcome } from "@nifrajs/core/ws"

const chat = server()
  .use(websocket())
  .ws("/room", { message: (ws, data) => ws.send(data) })

// Not a nifra server: it answers HTTP through fetch and builds its own upgrade outcome.
const topics = new TopicRegistry()
const legacy = {
  fetch: () => new Response("legacy"),
  resolveWebSocketUpgrade: (request: Request): WebSocketUpgradeOutcome =>
    new URL(request.url).pathname === "/feed"
      ? { kind: "upgrade", handler: { open: (ws) => ws.send("hello") }, data: undefined, pubsub: topics, attach: attachWebSocket }
      : { kind: "pass" },
}

server()
  .use(websocket()) // Bun: the parent holds the socket table every mounted upgrade runs through
  .mount({ path: "/chat", app: chat, stripPrefix: true })
  .mount({ path: "/legacy", app: legacy, stripPrefix: true })
  .listen(3000)`

export default function WebSockets() {
  return (
    <div className="prose">
      <h1 className="page">WebSockets</h1>
      <p className="lead">
        <code>app.ws(path, handler)</code> registers a WebSocket route. It mirrors{" "}
        <code>.get()</code>/<code>.post()</code> - chainable, with per-connection state typed
        through a generic - and runs on every runtime Nifra serves: Bun, Deno, Node, and Cloudflare
        Workers.
      </p>
      <p>
        The WebSocket runtime ships as an opt-in plugin, so apps that never use it don’t bundle it.
        Enable it with <code>.use(websocket())</code> from <code>@nifrajs/core/ws</code>;{" "}
        <code>app.ws()</code> without it fails loud at registration with{" "}
        <code>WS_RUNTIME_MISSING</code>. It installs on that server instance only - the same{" "}
        <code>.use()</code> opt-in as <code>mcp()</code> and <code>streaming()</code>.
      </p>
      <CodeBlock code={BASIC} />

      <h2>Lifecycle</h2>
      <p>
        Every callback is optional - <code>{"{ message }"}</code> alone is a valid echo server.{" "}
        <code>upgrade</code> is the only callback that runs before the socket opens, so it’s where a
        route rejects a connection or seeds its data.
      </p>
      <CodeBlock code={LIFECYCLE} />

      <h2>Guards</h2>
      <p>
        A handshake is a <code>GET</code>, and it runs the chain an HTTP <code>GET</code> registered
        at the same point runs: the <code>authenticate()</code> stages, <code>derive</code>s and{" "}
        <code>beforeHandle</code>s added before <code>app.ws()</code>, then <code>upgrade</code>. So
        auth middleware such as <code>basicAuth</code> or <code>jwt</code> guards the sockets
        registered after it, any guard can refuse the handshake with the response it would send an
        HTTP request, and <code>upgrade</code> reads what the guards derived. The origin check runs
        first. A socket registered before a guard stays public, like an HTTP route there. A browser
        cannot set a header on the handshake, so <code>authenticate()</code> can read a short-lived,
        single-use ticket from <code>input.query</code> - see{" "}
        <a href="/docs/auth#auth-first">Authentication runs first</a>.
      </p>
      <CodeBlock code={GUARDED} />
      <p>
        A socket declares the effects its code may reach with <code>capabilities</code>, as an HTTP
        route does. <code>nifra capabilities check</code> compares them with what the registering
        module can reach, and the handshake context carries the runtime guard for{" "}
        <code>upgrade()</code>. Reflection lists every socket under the pseudo-method{" "}
        <code>"WS"</code>, so <code>nifra assure</code> classifies sockets too.
      </p>

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
        <code>messageSchema</code> - any{" "}
        <a href="https://standardschema.dev">Standard Schema</a> (<code>t</code>, zod, valibot) - and
        Nifra parses each frame as JSON, validates it, and hands <code>message</code> the typed
        value; anything that fails goes to <code>onInvalidMessage</code> instead (so a malformed
        frame can never reach your handler). <code>nifra check</code> reports{" "}
        <code>NF-S009</code> (info) for a route whose <code>message</code> calls{" "}
        <code>JSON.parse</code> itself with no <code>messageSchema</code>.
      </p>
      <CodeBlock code={SCHEMA} />

      <h2>Optional outbound validation</h2>
      <p>
        <code>sendSchema</code> is type-level by default: it documents and types what the client
        receives with no runtime cost. Set <code>validateSend: true</code> to check server-sent JSON
        text and UTF-8 binary frames before the native socket sends them. Invalid frames and async
        validators fail closed and route a diagnostic to <code>error</code> when present. This is a
        contract check for your own output, not an inbound security boundary; the flag requires a{" "}
        <code>sendSchema</code> and is intentionally off by default.
      </p>
      <CodeBlock code={OUTBOUND} />

      <h2 id="typed-messages">Typed messages, end to end</h2>
      <p>
        Put both schemas in a module the server and the client import, each a{" "}
        <code>t.union</code> discriminated on a literal <code>type</code>. The server&apos;s{" "}
        <code>message</code> then switches over what the client sent, and the typed client&apos;s{" "}
        <code>.ws()</code> handle types <code>send</code> from <code>messageSchema</code> and every
        received frame from <code>sendSchema</code>. A <code>default</code> branch that assigns the
        frame to <code>never</code> turns a new server frame into a compile error on the client
        instead of a silently ignored message.
      </p>
      <p>
        The client types received frames but does not check them unless asked: pass the
        route&apos;s <code>sendSchema</code> as <code>validateReceive</code> (the typed client
        carries the contract&apos;s types, not its schemas, so the schema is the import). A frame
        that fails is not delivered; <code>onError</code> gets a <code>TypeError</code> naming the
        issues, with the frame as its <code>cause</code>. Frames keep their arrival order, an async
        schema included.
      </p>
      <CodeBlock code={TYPED_MESSAGES} />

      <h2 id="heartbeat">Frames the client must answer (heartbeats)</h2>
      <p>
        A server heartbeat that the application can see is an ordinary frame in the contract: a{" "}
        <code>ping</code> variant in <code>sendSchema</code> and a <code>pong</code> variant in{" "}
        <code>messageSchema</code>. The client answers it from the same switch that handles every
        other frame, so the answer is typed and the exhaustiveness check covers it; the server
        counts unanswered pings in <code>ws.data</code> and closes a connection that stops
        answering, as above. Clear the timer in <code>close</code>. WebSocket protocol pings (the
        runtime&apos;s own keep-alive) are answered by the socket itself and never reach{" "}
        <code>messages()</code>; use them to keep a connection open through proxies, and a frame
        in the contract when the server needs to know the client is still running.
      </p>

      <h2>Pub/sub - app.publish</h2>
      <p>
        <code>ws.subscribe(topic)</code> joins a topic; <code>app.publish(topic, data)</code>{" "}
        broadcasts to everyone in it. Subscriptions drop automatically when a connection closes.
      </p>
      <CodeBlock code={PUBSUB} />
      <p>
        Bun, Deno, and Node are long-lived processes, so this works directly on a single instance.
        Across a load balancer, <code>app.publish</code> only reaches sockets on the same instance -
        bridge an external fan-out (Redis pub/sub, NATS, a queue) to broadcast across all of them. On{" "}
        <strong>Cloudflare Workers</strong>, a stateless isolate can’t broadcast across connections,
        so Nifra ships a Durable Object hub: <code>createWebSocketHub(app)</code> holds the
        connections, and <code>toFetchHandler(app, {"{ webSocketHub }"})</code> routes upgrades to it
        - then <code>ws.subscribe</code> / <code>app.publish</code> behave exactly as on Bun. An
        upgrade request for a path with no WebSocket route still gets that path's HTTP answer, as on
        every other runtime.
      </p>
      <CodeBlock code={WORKERS} />

      <h2>Serving - adapter-integrated, not app.fetch</h2>
      <p>
        A WebSocket upgrade can’t go through <code>app.fetch(Request)</code> - it needs the live
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
        Node has no built-in WebSocket server, so <code>@nifrajs/node</code> uses <code>ws</code> - an
        optional peer dependency, lazy-imported on the first upgrade (a non-WS Node app never loads
        it). Install it when you use <code>app.ws()</code>; without it a WS upgrade gets a clean{" "}
        <code>501</code> and the HTTP routes are unaffected.
      </p>
      <CodeBlock code={NODE_WS} />
      <p>
        <code>server({"{ wsMaxPayloadBytes }"})</code> caps one inbound message (default{" "}
        <code>maxBodyBytes</code>, 1 MB): a socket that sends more is closed with <code>1009</code>{" "}
        and the message never reaches your handler. Bun and Node refuse it while it arrives. Deno's{" "}
        <code>Deno.upgradeWebSocket</code> takes no size limit, so Deno receives each message whole
        (up to its own limit, 64 MiB on Deno 2.9) before nifra can check it: the cap still keeps the
        message from your handler, but it does not bound the memory Deno spent receiving it. Where that
        matters, cap message size in a proxy in front of a Deno app.
      </p>

      <h2 id="composed">In a composed app</h2>
      <p>
        <code>mount({"{ path, app }"})</code> carries WebSocket upgrades as well as HTTP: when the
        serving adapter sees an upgrade under the mount's path, it asks the child's{" "}
        <code>resolveWebSocketUpgrade</code> and upgrades its own socket with the outcome. Any nifra
        server with <code>websocket()</code> installed has one. A child that is not a nifra server can
        implement it too, building the outcome from <code>@nifrajs/core/ws</code>:{" "}
        <code>attachWebSocket</code> wires the socket to a handler and a <code>TopicRegistry</code>{" "}
        owns its pub/sub. On Bun, install <code>websocket()</code> on the parent or on a mounted nifra
        child, or <code>listen()</code> refuses to start with <code>INVALID_WS_RUNTIME</code>.
      </p>
      <p>
        Each mounted nifra app keeps its own <code>wsMaxPayloadBytes</code>: a message over the
        child's cap closes that socket with <code>1009</code>, whether the cap is below or above the
        parent's. On Bun one listener serves them all, so its frame limit is the largest cap among the
        parent and the apps mounted on it, and a socket whose app declares less checks its own.
      </p>
      <p>
        <code>mountFetch(path, handler)</code> and a plain fetch handler carry HTTP only. An upgrade
        request under such a path reaches the handler as an ordinary request and never becomes a
        socket. Serve that path's WebSockets from a mounted child, or keep that server beside nifra.
      </p>
      <CodeBlock code={COMPOSED} lang="ts" />
    </div>
  )
}
