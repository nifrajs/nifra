import { afterEach, expect, test } from "bun:test"
import { connect } from "node:net"
import { server, silentLogger } from "@nifrajs/core"
import type { NodeResponseContext } from "@nifrajs/core/server"
import { type NodeServer, serve } from "../src/index.ts"

/**
 * The native response walk marks a header record it has proven all-lowercase, so the header view and
 * this adapter's direct JSON writer can skip re-deriving the same answer. The wire contract that mark
 * short-circuits is what these assert: every name reaches the socket in the spelling undici's
 * `Headers` would have produced, whether the record was marked, deliberately left unmarked, or
 * written past the view by a raw native twin after the mark was set.
 *
 * Read off a raw socket on purpose. Every HTTP client lowercases header names on the way in, so
 * `fetch` cannot tell a correctly-normalized response from one that shipped `X-Raw` - only the bytes
 * Node actually wrote can.
 */

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

/** The response head exactly as it went out, header names included. */
function rawHead(port: number, path = "/"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
    let text = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      text += chunk
    })
    socket.on("end", () => resolve(text.split("\r\n\r\n")[0] ?? ""))
    socket.on("error", reject)
  })
}

/** Header names as written, in wire order. */
async function wireNames(app: ReturnType<typeof server>): Promise<string[]> {
  running = await serve(app, { port: 0 })
  const head = await rawHead(running.port)
  return head
    .split("\r\n")
    .slice(1)
    .map((line) => line.slice(0, line.indexOf(":")))
    .filter((name) => name !== "Date" && name !== "Connection" && name !== "Keep-Alive")
}

test("a marked all-lowercase record ships exactly its own names, and no symbol leaks", async () => {
  const names = await wireNames(
    server({ logger: silentLogger })
      .onResponseHeaders((headers) => {
        headers.set("x-portable", "1")
      })
      .get("/", (c) => {
        c.set.headers["x-own"] = "2"
        return { ok: true }
      }),
  )
  // The mark is a symbol key: `Object.keys` never sees it, so it cannot become a header line.
  // (Node writes its own canonical spelling for the two framing headers it manages itself.)
  expect(names.sort()).toEqual(["Content-Length", "Content-Type", "x-own", "x-portable"])
})

test("a mixed-case name is still lowercased on the wire when a portable hook is installed", async () => {
  const names = await wireNames(
    server({ logger: silentLogger })
      .onResponseHeaders((headers) => {
        headers.set("x-portable", "1")
      })
      .get("/", (c) => {
        c.set.headers["X-Mixed-Case"] = "kept"
        return { ok: true }
      }),
  )
  expect(names).toContain("x-mixed-case")
  expect(names).not.toContain("X-Mixed-Case")
})

test("a hookless app's declared statics ship their names, marked without any scan", async () => {
  const names = await wireNames(
    server({ logger: silentLogger })
      .responseHeaders({ "X-Static": "1" })
      .get("/", (c) => {
        c.set.headers["x-own"] = "2"
        return { ok: true }
      }),
  )
  // Declared names are lowercased at registration, so the wire spelling is the lowercase one.
  expect(names.sort()).toEqual(["Content-Length", "Content-Type", "x-own", "x-static"])
})

test("a hookless app's mixed-case c.set write is still lowercased - the merge withholds the mark", async () => {
  const names = await wireNames(
    server({ logger: silentLogger })
      .responseHeaders({ "x-static": "1" })
      .get("/", (c) => {
        c.set.headers["X-Mixed-Case"] = "kept"
        return { ok: true }
      }),
  )
  expect(names).toContain("x-mixed-case")
  expect(names).not.toContain("X-Mixed-Case")
})

test("a raw native twin's mixed-case write is still lowercased - the mark is withheld for it", async () => {
  const names = await wireNames(
    server({ logger: silentLogger })
      .use({
        name: "raw-twin",
        onResponse: (res) => {
          res.headers.set("X-Raw", "1")
          return res
        },
        // Writes the record directly, past the case-normalizing view, and AFTER the point the walk
        // would otherwise have marked it. Registering this is what withholds the mark.
        onNodeResponse: (res: NodeResponseContext) => {
          res.headers ??= {}
          res.headers["X-Raw"] = "1"
        },
      })
      .get("/", () => ({ ok: true })),
  )
  expect(names).toContain("x-raw")
  expect(names).not.toContain("X-Raw")
})

test("declared statics do not mark for an app with a raw native twin", async () => {
  // The statics fold runs BEFORE hooks and could mark on their all-lowercase names alone. It must
  // not when a raw twin is registered: that twin writes the record afterwards, past the view, and a
  // mark set ahead of it would be a lie the writer trusts.
  const names = await wireNames(
    server({ logger: silentLogger })
      .responseHeaders({ "x-static": "1" })
      .use({
        name: "raw-twin",
        onResponse: (res) => {
          res.headers.set("X-Raw", "1")
          return res
        },
        onNodeResponse: (res: NodeResponseContext) => {
          res.headers ??= {}
          res.headers["X-Raw"] = "1"
        },
      })
      .get("/", () => ({ ok: true })),
  )
  expect(names).toContain("x-raw")
  expect(names).not.toContain("X-Raw")
})
