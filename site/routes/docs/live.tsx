import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/live",
  "Nifra - Live refresh",
  "Pages that stay fresh on their own: loaders declare live keys, a publish reloads only what read them, through the same authorized path a navigation takes.",
)

const RUNTIME = `import { live } from "@nifrajs/web/live"

// Your session lookup: a stable user id, or null for an anonymous viewer.
declare function sessionUserId(request: Request): Promise<string | null>

export const liveRuntime = live({
  secret: process.env.LIVE_SECRET, // openssl rand -base64 32; required in production
  subject: (ctx) => sessionUserId(ctx.request),
})`

const APP = `// doc-check: skip - adapter, manifest and the build are the app's own, as on the custom-server page.
const app = createWebApp({ adapter, manifest, clientEntry: build.entry, live: liveRuntime })

// The client build sends route loads through the live endpoints.
await buildClient({ routesDir, outDir, clientModule, live: liveRuntime.clientEntry })`

const LOADER = `// doc-check: skip - a route's backend half; db is the app's own.
export async function loader({ params, live }: Route.LoaderArgs) {
  live(\`post:\${params.id}\`, \`comments:\${params.id}\`)
  return { post: await db.post(params.id), comments: await db.comments(params.id) }
}`

const PUBLISH = `// doc-check: skip - db and the action's input are the app's own.
// After the write is readable by loaders:
await db.updatePost(id, input)
await liveRuntime.publish(\`post:\${id}\`)

// Or from an action, beside the paths and cache tags the write made stale:
return revalidate([\`/posts/\${id}\`], result, { keys: [\`post:\${id}\`] })`

const REVOKE = `// doc-check: skip - userId and projectId are the app's own.
await liveRuntime.revoke(userId) // every grant issued to them, and their sockets
await liveRuntime.revokeKey(\`project:\${projectId}\`, userId) // one key, for one viewer
await liveRuntime.revokeAll() // every grant issued before now`

const REDIS = `import { live } from "@nifrajs/web/live"
import { redisLiveBus } from "@nifrajs/web/live-redis"

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"
const send = new Bun.RedisClient(url)
const read = new Bun.RedisClient(url) // its own connection: XREAD blocks it

export const liveRuntime = live({
  secret: process.env.LIVE_SECRET,
  subject: () => null,
  bus: redisLiveBus({
    send: (command, args) => send.send(command, [...args]),
    read: (command, args) => read.send(command, [...args]),
  }),
  instances: 4, // processes serving the app, for spreading reloads
})`

const OPERATE = `// doc-check: skip - app, liveRuntime, send and read are the ones set up above.
import { healthcheck } from "@nifrajs/middleware"
import { livePublisher } from "@nifrajs/web/live"
import { redisLiveBus } from "@nifrajs/web/live-redis"

app.use(
  healthcheck({
    checks: {
      // Pages poll while the bus is down: report it without leaving rotation.
      live: { check: () => !liveRuntime.status().down, optional: true },
    },
  }),
)
app.onStop(async () => {
  await liveRuntime.close() // stop reading first, so closing its connection is no outage
  read.close()
  send.close()
})

// A process that only publishes - a worker, another app - needs no reader and no secret.
const publish = livePublisher(redisLiveBus({ send: (command, args) => send.send(command, [...args]) }))
await publish("org:42")`

const WORKERS = `// doc-check: skip - Env, adapter, manifest and the client entry are the worker's own.
import { live } from "@nifrajs/web/live"
import { liveHub } from "@nifrajs/web/live-hub"

// The hub: a SQLite-backed Durable Object class, bound as LIVE_HUB.
export class LiveHub extends liveHub((env: Env) => ({ secret: env.LIVE_SECRET })) {}

// Each isolate: the same secret, and the hub's namespace.
const runtime = live({ secret: env.LIVE_SECRET, subject, hub: env.LIVE_HUB })
const app = createWebApp({ adapter, manifest, clientEntry, live: runtime })`

const WRANGLER = `[durable_objects]
bindings = [{ name = "LIVE_HUB", class_name = "LiveHub" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["LiveHub"]`

const QUERY = `// doc-check: skip - id and fetchComments are the component's own.
// Server: live({ secret, subject, queryKeys: true })

// Client: refetch this query when comments:<id> changes.
const comments = useQuery(["comments", id], () => fetchComments(id), {
  live: [\`comments:\${id}\`],
})`

export default function Live() {
  return (
    <div className="prose">
      <h1 className="page">Live refresh</h1>
      <p className="lead">
        Pages stay fresh on their own. A loader declares the keys its data depends on; when one
        changes, every open page that read it reloads just the loaders that read it, through the
        same authorized path a navigation takes. A change notice never carries data.
      </p>

      <h2>Set up</h2>
      <p>
        Create one live runtime. <code>subject</code> names the viewer: a grant is only honored for
        the viewer it was issued to, and a different viewer on the same tab clears every cache the
        page holds.
      </p>
      <CodeBlock code={RUNTIME} />
      <p>
        Hand it to <code>createWebApp</code>, and give the client build its endpoints. With the CLI,
        export it as <code>live</code> from <code>backend/framework.ts</code> instead:{" "}
        <code>nifra dev</code> serves its socket, and <code>nifra build</code> does both.
      </p>
      <CodeBlock code={APP} />
      <p>
        A server-rendered page carries a seed: the grant for what its loaders declared, bound to no
        socket yet. Once the tab's socket opens, one live load trades it for that socket's grant and
        keeps every owner, so no loader runs again; only gates do. A seed is refused after a minute,
        for another viewer, another page or a renewal, and then the page loads as it would without
        one. Partially prerendered pages, server-component routes and Workers apps render without a
        seed.
      </p>

      <h2>Declare keys</h2>
      <p>
        <code>live(...keys)</code> in any loader, page or layout, names what its data reads. A key
        is your own name for a piece of data, such as <code>post:42</code>: a letter, then up to
        127 of <code>A-Z a-z 0-9 . _ : / -</code>. A frame holds at most 64. A live load returns
        an encrypted grant for its keys beside the data. A hole of a{" "}
        <a href={href({ to: "/docs/partial-prerendering" })}>partially prerendered page</a> declares its own the
        same way, and a change reloads that hole alone.
      </p>
      <CodeBlock code={LOADER} />

      <h2>Publish changes</h2>
      <p>
        Call <code>publish(...keys)</code> once the write is readable by loaders. With read
        replicas, pass <code>live({"{ visible }"})</code>, a function that resolves once loaders can
        read the write; every publish waits for it. An action can name the keys it changed in{" "}
        <code>revalidate()</code>, which publishes them after the caches it clears.
      </p>
      <CodeBlock code={PUBLISH} />
      <p>
        Each tab holds one WebSocket. A change reaches it as an opaque tag: no data, key text,
        subject or sequence number is on the wire. The tab reloads only the loaders whose keys
        changed, keeps the rest as shown, and spreads reloads over up to five seconds when many tabs
        watch one key. Live loads are capped per process (<code>maxConcurrentLoads</code>, default
        64) and answered 503 past it, so a hot key cannot overload your database. In a load test of
        10,000 tabs on one key across two Bun processes, no process ran more than 64 loaders at
        once, and with <code>reloadRate: 5000</code> every tab had the new data within 2.1 seconds.
      </p>

      <h2>Revoke access</h2>
      <CodeBlock code={REVOKE} />
      <p>
        A revoked key sends one last change to every affected socket, and no grant issued before the
        revocation keeps or re-signs it, so the next load runs that loader, which decides again.
      </p>

      <h2>Many processes</h2>
      <p>
        The default bus serves one process. Behind a load balancer, give every process the same
        Redis Streams log. A reader that falls behind the stream's trim, or whose connection stops
        answering (<code>readTimeoutMs</code>), resyncs its sockets rather than miss a change.
      </p>
      <CodeBlock code={REDIS} />
      <p>
        Each process reports through <code>logger</code> (default: JSON lines on stderr) when the bus
        stops answering, when it answers again and when events were lost to a trim.{" "}
        <code>liveRuntime.status()</code> has the same state to poll - <code>down</code>, open{" "}
        <code>sockets</code>, running <code>loads</code>, applied <code>events</code>, the{" "}
        <code>changed</code> frames sent as <code>notified</code>, and <code>lagMs</code> - for a
        readiness check or metrics. <code>close()</code> stops the reader and closes the sockets;
        call it before closing the bus's connections. Another process can publish to the same stream
        with <code>livePublisher</code> and a bus that has <code>send</code> only. Any client with a
        raw-command call works: with ioredis, <code>(command, args) =&gt; redis.call(command,
        ...args)</code>.
      </p>
      <CodeBlock code={OPERATE} />

      <h2>Cloudflare Workers</h2>
      <p>
        On Workers, one hibernating Durable Object per app owns the log and holds every socket.
        Request isolates run live loads themselves and forward only the socket handshake to it. The
        hub answers heartbeats without waking, keeps revocations and socket membership in storage,
        and refuses calls from an app whose <code>secret</code>, <code>appId</code> or{" "}
        <code>grantTtl</code> differ from its own. It holds 5,000 sockets and 150,000 socket-tag
        subscriptions by default (<code>maxSockets</code>, <code>maxMemberships</code>).
      </p>
      <CodeBlock code={WORKERS} />
      <CodeBlock code={WRANGLER} />

      <h2>Query hooks</h2>
      <p>
        A <code>useQuery</code> can name the live keys its data depends on. With{" "}
        <code>queryKeys: true</code>, each live load also carries a salted digest of every key it
        grants; the page matches its queries' keys against them, and a change to one refetches the
        query. In development, a query key no loader on the page grants logs a warning: nothing
        would refresh it.
      </p>
      <CodeBlock code={QUERY} />
      <p>
        The digests let page code confirm a guess at a key its loaders read. Leave{" "}
        <code>queryKeys</code> off if your key names hold anything the viewer should not see.
      </p>

      <h2>Rotate the secret</h2>
      <p>
        Put the new secret first and keep the old one listed: <code>secret: [next, current]</code>.
        Grants sealed under either keep working, and a viewer stays the same viewer whichever
        process serves the load. Remove the old secret once every process runs the new list and
        another <code>grantTtl</code> plus a minute has passed.
      </p>

      <h2>Security</h2>
      <ul>
        <li>
          Grants are sealed with AES-256-GCM and bound to one socket, path, frame and viewer. They
          expire (<code>grantTtl</code>, default 10 minutes, at most an hour); tabs renew them. A
          page's seed is bound to no socket, so no socket accepts it; only a load of its own page, for
          its own viewer, within a minute of the render, exchanges it. A shared cache that stores the
          page stores a seed nobody else can use.
        </li>
        <li>
          The load endpoint and the socket check <code>Origin</code>; allow other origins with{" "}
          <code>trustedOrigins</code>.
        </li>
        <li>
          Every reload runs your hooks, middleware, gates and loaders exactly as a navigation does.
        </li>
        <li>
          Sockets, watches and outbound buffers are bounded per socket and per process (
          <code>maxSockets</code>, <code>maxRssBytes</code>). A socket that holds no key for a
          minute is closed, so holding one costs a live load. Limit connections per client at your
          proxy as well: the socket cap is shared by every visitor.
        </li>
      </ul>
    </div>
  )
}
