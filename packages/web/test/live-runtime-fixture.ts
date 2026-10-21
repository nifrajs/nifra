/**
 * One live round trip over a real server, run on Bun, on Node and on Deno: a socket's welcome, a live
 * load, a watch, a change reaching the socket as the grant's tag, and the heartbeat. The file imports
 * nothing: each suite passes in `createWebApp`, `live` and its own WebSocket client.
 */

/** The `createWebApp` and `live` a suite imports, as far as the fixture uses them. */
export interface LiveKit<App> {
  createWebApp(options: {
    adapter: object
    manifest: object
    clientEntry?: string
    live?: unknown
  }): App
  live(options: { secret: string; subject: (ctx: { request: Request }) => string | null }): {
    publish(...keys: string[]): Promise<void>
    readonly ready: Promise<void>
  }
}

const empty = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.close()
    },
  })

/** An app whose page `/posts/:id` reads key `post:<id>`, under a layout that reads `site:nav`. */
export function liveApp<App>(kit: LiveKit<App>) {
  const runtime = kit.live({
    secret: "live-runtime-fixture-secret-0123456789",
    subject: (ctx) => (ctx.request.headers.get("cookie")?.includes("user=alice") ? "alice" : null),
  })
  const app = kit.createWebApp({
    adapter: { renderToStream: empty, hydrationHead: () => "" },
    clientEntry: "/c.js",
    live: runtime,
    manifest: {
      routes: [
        {
          id: "posts/[id]",
          pattern: "/posts/:id",
          layoutIds: ["_layout"],
          layoutParams: [[]],
          file: "posts/[id].tsx",
          load: async () => ({
            default: "post",
            loader: (ctx: { params: Record<string, string>; live(...keys: string[]): void }) => {
              ctx.live(`post:${ctx.params.id}`)
              return { id: ctx.params.id }
            },
          }),
        },
      ],
      layouts: {
        _layout: {
          file: "root.tsx",
          load: async () => ({
            default: "root",
            loader: (ctx: { live(...keys: string[]): void }) => {
              ctx.live("site:nav")
              return { root: true }
            },
          }),
        },
      },
      notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
    },
  })
  return { app, runtime }
}

type Frame = Record<string, unknown> | "p"

/** Opens a socket with an `Origin` header; each runtime's client takes headers its own way. */
export type OpenSocket = (url: string, origin: string) => WebSocket

/**
 * Everything the socket heard, in order, beside what it should have heard. `base` is the server's
 * `http://host:port`.
 */
export async function liveRoundTrip(
  runtime: { publish(...keys: string[]): Promise<void> },
  base: string,
  open: OpenSocket,
): Promise<{ readonly heard: Frame[]; readonly expected: Frame[] }> {
  const socket = open(`${base.replace("http", "ws")}/_nifra/live`, base)
  const inbox: Frame[] = []
  const waiting: ((frame: Frame) => void)[] = []
  socket.addEventListener("message", (event) => {
    const text = String(event.data)
    const frame: Frame = text === "p" ? "p" : JSON.parse(text)
    const waiter = waiting.shift()
    if (waiter === undefined) inbox.push(frame)
    else waiter(frame)
  })
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code)),
  )
  const next = (): Promise<Frame> => {
    const frame = inbox.shift()
    if (frame !== undefined) return Promise.resolve(frame)
    return Promise.race([
      new Promise<Frame>((resolve) => waiting.push(resolve)),
      closed.then((code) => {
        throw new Error(`[fixture] the live socket closed with ${code}`)
      }),
    ])
  }
  const heard: Frame[] = []
  const welcome = await next()
  heard.push(welcome)
  const sid = welcome === "p" ? "" : String(welcome.sid)
  const res = await fetch(`${base}/_nifra/live/load`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", cookie: "user=alice" },
    body: JSON.stringify({
      path: "/posts/42",
      sid,
      frame: "page",
      mode: "load",
      retain: [],
      grants: [],
    }),
  })
  const envelope: { live?: { grant?: string; tags?: Record<string, string[]> } } = await res.json()
  const grant = envelope.live?.grant
  const tags = envelope.live?.tags ?? {}
  const tagOf = (owner: string): string | undefined =>
    Object.entries(tags).find(([, owners]) => owners.includes(owner))?.[0]
  socket.send(JSON.stringify({ t: "watch", gen: 1, grants: [grant] }))
  heard.push(await next())
  await runtime.publish("post:42")
  heard.push(await next())
  socket.send("p")
  heard.push(await next())
  socket.close()
  return {
    heard,
    expected: [
      { t: "welcome", sid },
      { t: "ready", gen: 1, stale: [[]] },
      { t: "changed", tag: tagOf("P:posts/[id]") ?? "<no tag>", spread: 0 },
      "p",
    ],
  }
}
