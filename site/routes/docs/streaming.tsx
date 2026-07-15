import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Streaming",
  "Streaming SSR, Suspense, and defer() in Nifra — on every runtime including the edge.",
)

const DEFER = `// Send the page shell immediately; stream the slow part in when it resolves.
export async function loader({ api }: LoaderArgs<typeof app>) {
  return {
    user: (await api.users({ id: "7" }).get()).data,   // awaited — in the shell
    feed: defer(api.feed.get()),                        // deferred — streamed later
  }
}

export default function Page(props: { data: LoaderData<typeof loader> }) {
  return (
    <>
      <h1>{props.data.user?.id}</h1>
      <Await resolve={props.data.feed} fallback={<p>Loading feed…</p>}>
        {(feed) => <Feed items={feed} />}
      </Await>
    </>
  )
}`

const SSE = `import { server, sse } from "@nifrajs/core/server"

const app = server()
// Your pub-sub of choice — subscribe returns an unsubscribe function.
declare const notifications: { subscribe(on: (n: { id: string }) => void): () => void }

// A live feed — push events until the client disconnects.
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

export default function Streaming() {
  return (
    <div className="prose">
      <h1 className="page">Streaming</h1>
      <p className="lead">
        Nifra streams HTML as it renders — the shell goes out first, slow data fills in. It's a Web{" "}
        <code>ReadableStream</code>, so it works on Bun, Node, Deno, <b>and</b> the edge (workerd).
      </p>

      <h2>Suspense &amp; defer()</h2>
      <p>
        Wrap slow data in <code>defer()</code> in the loader and render it through{" "}
        <code>&lt;Await&gt;</code> (a Suspense boundary). The client receives the shell + a streamed
        resolution, then hydrates — no waterfall, no blank screen.
      </p>
      <CodeBlock code={DEFER} />

      <p>
        The same <code>defer()</code> works in actions and across client-side soft navigations (an
        NDJSON stream settles the deferred values), and it's framework-agnostic — React{" "}
        <code>&lt;Suspense&gt;</code> and Solid's streaming both drive it from one core.
      </p>

      <h2>Server-Sent Events</h2>
      <p>
        For server push — live feeds, progress, notifications — <code>sse(c, run)</code> returns a{" "}
        <code>text/event-stream</code> response a handler returns directly. Push frames with{" "}
        <code>stream.send(&#123;&#125;)</code>; the connection stays open until <code>run</code>{" "}
        resolves, you call <code>stream.close()</code>, or the client disconnects (
        <code>stream.signal</code>). It's a Web <code>ReadableStream</code> too, so it runs on Bun,
        Node, Deno, and the edge — no <code>new Function</code>, no per-runtime API.
      </p>
      <CodeBlock code={SSE} />
      <p>
        <code>event:</code>, <code>id:</code>, and <code>retry:</code> are supported (and CR/LF is
        stripped from <code>event</code>/<code>id</code> to prevent frame injection); multi-line{" "}
        <code>data</code> is split into multiple <code>data:</code> lines per the spec; and{" "}
        <code>keepAlive</code> emits comment pings so idle proxies don't drop the connection.
      </p>
    </div>
  )
}
