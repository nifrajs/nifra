import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"

export const meta = docsMeta(
  "/docs/streaming",
  "Nifra - Streaming",
  "Streaming SSR, Suspense, and defer() in Nifra - on every runtime including the edge.",
)

const DEFER = `// routes/index.backend.ts - send the page shell immediately; stream the slow part when it resolves.
import { t } from "@nifrajs/schema"
import { defer } from "@nifrajs/web"
import type { Route } from "./+types/index"

declare function loadFeed(userId: string): Promise<string[]>

export const loaderOutput = t.object({
  name: t.string(),                                   // awaited - in the shell
  feed: t.deferred(t.array(t.string())),              // deferred - streamed later
})

export async function loader({ api }: Route.LoaderArgs) {
  const user = await api.users({ id: "7" }).get()
  return {
    name: user.ok ? user.data.name : "",
    feed: defer(loadFeed("7")),
  }
}`

const DEFER_PAGE = `// routes/index.tsx
import type { Route } from "./+types/index"

export default function Page({ data }: Route.ComponentProps) {
  return (
    <>
      <h1>{data.name}</h1>
      <Await resolve={data.feed} fallback={<p>Loading feed…</p>}>
        {(feed) => <Feed items={feed} />}
      </Await>
    </>
  )
}`

const SSE = `import { server } from "@nifrajs/core/server"
import { sse } from "@nifrajs/core/sse"

const app = server()
// Your pub-sub of choice - subscribe returns an unsubscribe function.
declare const notifications: { subscribe(on: (n: { id: string }) => void): () => void }

// A live feed - push events until the client disconnects.
app.get("/notifications", (c) =>
  sse(c, (stream) => {
    const off = notifications.subscribe((n) =>
      stream.send({ event: "notification", id: n.id, data: JSON.stringify(n) }),
    )
    // Keep the connection open until the client leaves, then tear down.
    return new Promise<void>((resolve) =>
      stream.signal.addEventListener("abort", () => { off(); resolve() }, { once: true }),
    )
  }, { keepAlive: 15_000 }),
)`

const TYPED_SSE = `import { client } from "@nifrajs/client"
import { server } from "@nifrajs/core/server"
import { streaming } from "@nifrajs/core/sse"
import { t } from "@nifrajs/schema"

declare function generate(prompt: string): AsyncIterable<string>

export const app = server()
  .use(streaming())
  // A GET stream: the event payload is contracted by \`sse\`.
  .sse("/feed", { sse: t.object({ id: t.integer(), title: t.string() }) }, (_c, stream) => {
    stream.send({ id: 1, title: "hello" })
    stream.close()
  })
  // A body makes it a POST stream, validated like any POST: a chat that posts its prompt.
  .sse(
    "/chat",
    { body: t.object({ prompt: t.string() }), sse: t.object({ token: t.string() }) },
    async (c, stream) => {
      for await (const token of generate(c.body.prompt)) stream.send({ token })
      stream.close()
    },
  )

const api = client<typeof app>("https://example.com")
const feed = api.feed.subscribe((post) => console.log(post.title))
api.chat.subscribe((event) => console.log(event.token), { body: { prompt: "Hi" } })
feed.close()`

export default function Streaming() {
  return (
    <div className="prose">
      <h1 className="page">Streaming</h1>
      <p className="lead">
        Nifra streams HTML as it renders - the shell goes out first, slow data fills in. It's a Web{" "}
        <code>ReadableStream</code>, so it works on Bun, Node, Deno, <b>and</b> the edge (workerd).
      </p>

      <h2>Suspense &amp; defer()</h2>
      <p>
        Wrap slow data in <code>defer()</code> in the loader and render it through{" "}
        <code>&lt;Await&gt;</code> (a Suspense boundary). The client receives the shell + a streamed
        resolution, then hydrates - no waterfall, no blank screen.
      </p>
      <CodeBlock code={DEFER} lang="ts" />
      <CodeBlock code={DEFER_PAGE} />

      <p>
        The same <code>defer()</code> works in actions and across client-side soft navigations (an
        NDJSON stream settles the deferred values), and it's framework-agnostic - React{" "}
        <code>&lt;Suspense&gt;</code> and Solid's streaming both drive it from one core.
      </p>

      <h2>Server-Sent Events</h2>
      <p>
        For server push - live feeds, progress, notifications - <code>sse(c, run)</code> returns a{" "}
        <code>text/event-stream</code> response a handler returns directly. Push frames with{" "}
        <code>stream.send(&#123;&#125;)</code>; the connection stays open until <code>run</code>{" "}
        resolves, you call <code>stream.close()</code>, or the client disconnects (
        <code>stream.signal</code>). It's a Web <code>ReadableStream</code> too, so it runs on Bun,
        Node, Deno, and the edge - no <code>new Function</code>, no per-runtime API.
      </p>
      <CodeBlock code={SSE} />
      <p>
        <code>event:</code>, <code>id:</code>, and <code>retry:</code> are supported (and CR/LF is
        stripped from <code>event</code>/<code>id</code> to prevent frame injection); multi-line{" "}
        <code>data</code> is split into multiple <code>data:</code> lines per the spec; and{" "}
        <code>keepAlive</code> emits comment pings so idle proxies don't drop the connection.
      </p>
      <p>
        A client that stops reading is dropped once it has <code>maxBufferedBytes</code> (default 1
        MiB) of events unread: <code>stream.signal</code> aborts with <code>sse_client_too_slow</code>,
        the queued frames are released, and later sends do nothing, so one stalled reader cannot hold
        server memory without limit. Raise it for a burst larger than that sent before the client can
        read, or pass <code>Infinity</code> to turn the limit off.
      </p>

      <h2 id="typed-sse">Typed SSE routes</h2>
      <p>
        <code>app.sse(path, schema, run)</code> declares the event payload with <code>sse</code>, so{" "}
        <code>stream.send()</code> is type-checked and the typed client grows{" "}
        <code>.subscribe(onEvent)</code> with the same event type. A route whose schema declares a{" "}
        <code>body</code> is a POST stream: the body validates as on any POST, and{" "}
        <code>.subscribe(onEvent, &#123; body &#125;)</code> sends it. A GET stream reconnects after a
        drop and resumes with <code>Last-Event-ID</code>; a POST stream does not reconnect unless you
        pass <code>reconnect: true</code>, since a reconnect sends the body again. The client&apos;s{" "}
        <code>onRequest</code> hook runs before each connect, so a refreshed token reaches the stream.
      </p>
      <CodeBlock code={TYPED_SSE} />
    </div>
  )
}
