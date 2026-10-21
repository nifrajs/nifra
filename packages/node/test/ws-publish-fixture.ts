/**
 * One publish check over real sockets, run by the Bun suite and on Node itself: every length class of
 * the frame header and non-ASCII text reach each subscriber byte for byte, and a socket's own send
 * between publishes keeps its place. The file imports nothing: each suite builds the app from its own
 * `server`.
 */

/** The part of `server().use(websocket())` the fixture uses. */
interface PublishRoutable {
  ws(path: string, handler: object): unknown
  publish(topic: string, data: string): unknown
}

interface FeedSocket {
  subscribe(topic: string): void
  send(data: string): void
}

/** Every length class of the frame header, an empty text, and non-ASCII text sent twice. */
export const PUBLISHED: readonly string[] = [
  "",
  "a".repeat(125),
  "b".repeat(126),
  "c".repeat(65_535),
  "d".repeat(65_536),
  "naïve ☃ 𝄞 text",
  "naïve ☃ 𝄞 text",
]

/** Registers `/feed` on `app`: every socket joins topic `feed` and echoes what it is sent. */
export function publishFeedApp<App extends PublishRoutable>(
  app: App,
): { readonly app: App; joined(): number } {
  let joined = 0
  app.ws("/feed", {
    open: (ws: FeedSocket) => {
      ws.subscribe("feed")
      joined++
    },
    message: (ws: FeedSocket, data: unknown) => ws.send(`echo:${String(data)}`),
  })
  return { app, joined: () => joined }
}

/** What each of three subscribers read of `texts`, beside what each should have read. */
export async function publishRoundTrip(
  feed: { readonly app: PublishRoutable; joined(): number },
  port: number,
  texts: readonly string[] = PUBLISHED,
): Promise<{ readonly got: string[][]; readonly expected: string[][] }> {
  const clients = Array.from({ length: 3 }, () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/feed`)
    const got: string[] = []
    socket.addEventListener("message", (event) => got.push(String(event.data)))
    return {
      socket,
      got,
      open: new Promise((resolve) => socket.addEventListener("open", resolve)),
    }
  })
  const [first] = clients
  if (first === undefined) throw new Error("[fixture] no clients")
  await Promise.all(clients.map((client) => client.open))
  await turnsUntil(() => feed.joined() === clients.length, "every socket joined")
  for (const text of texts) feed.app.publish("feed", text)
  first.socket.send("x")
  await turnsUntil(() => first.got.length === texts.length + 1, "the echo")
  feed.app.publish("feed", "after")
  const expected = clients.map((client) =>
    client === first ? [...texts, "echo:x", "after"] : [...texts, "after"],
  )
  await turnsUntil(
    () => clients.every((client, i) => client.got.length >= (expected[i]?.length ?? 0)),
    "every frame",
  )
  for (const client of clients) client.socket.close()
  return { got: clients.map((client) => client.got), expected }
}

/** Event-loop turns, not wall-clock: a check that never holds fails instead of hanging the suite. */
async function turnsUntil(ok: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 1_000_000; turn++) {
    if (ok()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`[fixture] never: ${what}`)
}
