/**
 * One request-target matrix, run over a real socket on every runtime nifra serves.
 *
 * A client can send a path with `.` and `..` segments (raw or `%2e`) or a backslash. A WHATWG URL
 * parser resolves those - `/users/../posts` is a request for `/posts` - and that is the URL Bun and
 * workerd hand an app. Whatever the runtime delivers, the app routes the resolved path; these cases
 * hold every runtime to the same answer.
 *
 * `fetch` resolves a URL before it sends it, so the cases go over a raw socket. `node:net` is here
 * because Bun, Node and Deno all provide it. The file imports nothing else: each suite builds the
 * app from its own `server`.
 */
import { connect } from "node:net"

/** The part of `server()` the matrix app uses. */
interface Routable {
  get(path: string, handler: (c: MatrixContext) => unknown): Routable
  post(path: string, handler: (c: MatrixContext) => unknown): Routable
  delete(path: string, handler: (c: MatrixContext) => unknown): Routable
}
interface MatrixContext {
  readonly params: Record<string, string>
  readonly req: Request
}

export function requestTargetApp<App>(app: App): App {
  const routes = app as unknown as Routable
  routes
    .get("/", () => ({ route: "GET /" }))
    .delete("/", () => ({ route: "DELETE /" }))
    .get("/posts", () => ({ route: "GET /posts" }))
    .get("/users/:id", (c) => ({ route: "GET /users/:id", id: c.params.id }))
    .get("/users/:id/posts", (c) => ({ route: "GET /users/:id/posts", id: c.params.id }))
    .post("/echo", async (c) => ({
      route: "POST /echo",
      url: new URL(c.req.url).pathname,
      type: c.req.headers.get("content-type"),
      body: await c.req.text(),
    }))
  return app
}

export interface RequestTargetCase {
  readonly method: string
  /** Sent on the request line exactly as written. */
  readonly target: string
  readonly body?: string
  /** The JSON the app answers with. */
  readonly answer: Record<string, unknown>
}

export const REQUEST_TARGET_CASES: readonly RequestTargetCase[] = [
  { method: "GET", target: "/users/..", answer: { route: "GET /" } },
  { method: "DELETE", target: "/users/..", answer: { route: "DELETE /" } },
  { method: "GET", target: "/users/../posts", answer: { route: "GET /posts" } },
  { method: "GET", target: "/users/%2e%2e/posts", answer: { route: "GET /posts" } },
  { method: "GET", target: "/users/%2E./posts", answer: { route: "GET /posts" } },
  { method: "GET", target: "/users/..\\posts", answer: { route: "GET /posts" } },
  { method: "GET", target: "/users/./7", answer: { route: "GET /users/:id", id: "7" } },
  {
    method: "GET",
    target: "/users/7/%2e/posts",
    answer: { route: "GET /users/:id/posts", id: "7" },
  },
  {
    method: "POST",
    target: "/users/../echo",
    body: '{"a":1}',
    answer: { route: "POST /echo", url: "/echo", type: "application/json", body: '{"a":1}' },
  },
  // Not dot segments: an encoded backslash is data, and so is a dot inside a longer segment.
  { method: "GET", target: "/users/a%5Cb", answer: { route: "GET /users/:id", id: "a\\b" } },
  { method: "GET", target: "/users/...", answer: { route: "GET /users/:id", id: "..." } },
  { method: "GET", target: "/users/.a", answer: { route: "GET /users/:id", id: ".a" } },
  // The query is not part of the path.
  { method: "GET", target: "/users/7?next=/../x", answer: { route: "GET /users/:id", id: "7" } },
  // Absolute-form (RFC 9112 section 3.2.2) routes its path with the Host header, as Bun does: the
  // target's authority never becomes part of the path the hooks and the router see.
  {
    method: "GET",
    target: "http://other.example/users/7",
    answer: { route: "GET /users/:id", id: "7" },
  },
  { method: "GET", target: "http://other.example", answer: { route: "GET /" } },
  {
    method: "POST",
    target: "http://other.example/users/../echo?x=1",
    body: '{"a":1}',
    answer: { route: "POST /echo", url: "/echo", type: "application/json", body: '{"a":1}' },
  },
]

export interface RawAnswer {
  readonly status: number
  readonly body: string
}

/** Send one request with `target` on the request line, byte for byte, and read the answer. */
export function rawExchange(
  port: number,
  method: string,
  target: string,
  body?: string,
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    const chunks: Buffer[] = []
    socket.on("connect", () => {
      const head = [`${method} ${target} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close"]
      if (body !== undefined) {
        head.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`)
      }
      socket.write(`${head.join("\r\n")}\r\n\r\n${body ?? ""}`)
    })
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.on("error", reject)
    socket.on("end", () => {
      try {
        resolve(parseResponse(Buffer.concat(chunks).toString("latin1")))
      } catch (error) {
        reject(error)
      }
    })
  })
}

/** The status a WebSocket handshake sent to `target`, byte for byte, is answered with. */
export function rawUpgradeStatus(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    let head = ""
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      )
    })
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1")
      if (!head.includes("\r\n\r\n")) return
      socket.destroy()
      resolve(Number(head.split(" ")[1]))
    })
    socket.on("error", reject)
    socket.on("end", () => reject(new Error(`closed before a response head: ${head}`)))
  })
}

function parseResponse(text: string): RawAnswer {
  const split = text.indexOf("\r\n\r\n")
  if (split === -1) throw new Error(`no response head in ${JSON.stringify(text)}`)
  const lines = text.slice(0, split).split("\r\n")
  const status = Number(lines[0]!.split(" ")[1])
  const chunked = lines.some((line) => /^transfer-encoding:\s*chunked/i.test(line))
  let body = text.slice(split + 4)
  if (chunked) {
    let decoded = ""
    for (let at = 0; ; ) {
      const eol = body.indexOf("\r\n", at)
      const size = Number.parseInt(body.slice(at, eol), 16)
      if (!(size > 0)) break
      decoded += body.slice(eol + 2, eol + 2 + size)
      at = eol + 2 + size + 2
    }
    body = decoded
  }
  return { status, body: Buffer.from(body, "latin1").toString("utf8") }
}

/** Every case whose answer differs from the matrix, one line each. Empty when all agree. */
export async function requestTargetMismatches(port: number): Promise<string[]> {
  const mismatches: string[] = []
  for (const { method, target, body, answer } of REQUEST_TARGET_CASES) {
    const got = await rawExchange(port, method, target, body)
    const expected = JSON.stringify(answer)
    if (got.status !== 200 || got.body !== expected) {
      mismatches.push(`${method} ${target}: got ${got.status} ${got.body}, expected ${expected}`)
    }
  }
  return mismatches
}
