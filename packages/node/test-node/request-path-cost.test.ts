/**
 * Per-request work `serve()` must not add to Node's request path, pinned without a benchmark.
 *
 * Each of these once cost nifra 1-3% of its throughput against fastify - a size run-to-run noise
 * hides, so no timing gate caught them. Building `req.headers` for a Host lookup turned every GET
 * into a full header parse; a pair of `finish`/`close` listeners on every response existed only for
 * the rare parser-error path. Both are counted here against a bare `node:http` server.
 */

import assert from "node:assert/strict"
import { createServer, IncomingMessage, Server, type ServerResponse } from "node:http"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

interface Observed {
  headerReads: number
  /** `event:count` for every listener on the response when the handler ends it. */
  listenersAtEnd: string | undefined
}

/** Watches each request an `http.Server` dispatches while `run` is in progress. */
async function observe(run: () => Promise<void>): Promise<Observed[]> {
  const seen: Observed[] = []
  const originalEmit = Server.prototype.emit
  Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      const [req, res] = args as [IncomingMessage, ServerResponse]
      const observed: Observed = { headerReads: 0, listenersAtEnd: undefined }
      seen.push(observed)
      Object.defineProperty(req, "headers", {
        configurable: true,
        get() {
          observed.headerReads++
          return Reflect.get(IncomingMessage.prototype, "headers", req)
        },
        set(value: unknown) {
          Reflect.set(IncomingMessage.prototype, "headers", value, req)
        },
      })
      const end = res.end
      res.end = function (this: ServerResponse, ...endArgs: unknown[]) {
        observed.listenersAtEnd ??= res
          .eventNames()
          .map((name) => `${String(name)}:${res.listenerCount(name)}`)
          .sort()
          .join(" ")
        return Reflect.apply(end, this, endArgs)
      } as typeof res.end
    }
    return Reflect.apply(originalEmit, this, [event, ...args])
  } as typeof originalEmit
  try {
    await run()
  } finally {
    Server.prototype.emit = originalEmit
  }
  return seen
}

async function viaServe(app: Parameters<typeof serve>[0], init?: RequestInit): Promise<void> {
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/users/123`, init)
    assert.equal(res.status, 200)
    await res.text()
  } finally {
    await running.stop({ drainMs: 0 })
  }
}

async function viaBare(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  init?: RequestInit,
): Promise<void> {
  const bare = createServer(handler)
  await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve))
  try {
    const { port } = bare.address() as { port: number }
    const res = await fetch(`http://127.0.0.1:${port}/users/123`, init)
    assert.equal(res.status, 200)
    await res.text()
  } finally {
    bare.closeAllConnections()
    await new Promise((resolve) => bare.close(resolve))
  }
}

const json = (res: ServerResponse, body: unknown): void => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

test("the observer sees a handler that reads req.headers", async () => {
  const seen = await observe(() => viaBare((req, res) => json(res, { host: req.headers.host })))
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.headerReads, 1)
})

test("a GET whose route reads no header never builds req.headers", async () => {
  const app = server().get("/users/:id", (c) => ({ id: c.params.id }))
  const seen = await observe(() => viaServe(app))
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.headerReads, 0)
})

test("serve() leaves a response's listeners as bare node:http has them", async () => {
  const app = server()
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .post("/users/:id", async (c) => ({ id: c.params.id, ...((await c.req.json()) as object) }))
  const post: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  }
  const nifra = await observe(async () => {
    await viaServe(app)
    await viaServe(app, post)
  })
  const bare = await observe(async () => {
    await viaBare((_req, res) => json(res, { id: "123" }))
    await viaBare((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => json(res, { id: "123", ...JSON.parse(body) }))
    }, post)
  })
  assert.equal(nifra.length, 2)
  assert.notEqual(bare[0]?.listenersAtEnd, undefined)
  assert.deepEqual(
    nifra.map((seen) => seen.listenersAtEnd),
    bare.map((seen) => seen.listenersAtEnd),
  )
})
