import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { test } from "node:test"
import { server } from "@nifrajs/core/server"
import { serve as serveNode } from "@nifrajs/node"
import { t } from "@nifrajs/schema"
import { serve } from "../dist/index.js"

const settings = { port: 0, hostname: "127.0.0.1" }
const nativeTest = { skip: process.env.NIFRA_RUST_ENGINE_PATH === undefined, timeout: 10_000 }

test(
  "Rust responds to requests buffered before a peer closes its send side",
  nativeTest,
  async () => {
    const app = server()
      .get("/ready", () => "ready")
      .get("/answer", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return "answer"
      })
    const running = await serve(app, settings)
    try {
      const response = await new Promise((resolve, reject) => {
        const socket = createConnection(running.port, settings.hostname)
        const chunks = []
        socket.on("error", reject)
        socket.setTimeout(3000, () => socket.destroy(new Error("response timed out")))
        socket.on("data", (chunk) => chunks.push(chunk))
        socket.on("end", () => resolve(Buffer.concat(chunks).toString()))
        socket.on("connect", () => {
          const ready = "GET /ready HTTP/1.1\r\nHost: localhost\r\n\r\n"
          socket.end(ready.repeat(260) + "GET /answer HTTP/1.1\r\nHost: localhost\r\n\r\n")
        })
      })
      assert.match(response, /^HTTP\/1\.1 200 /)
      assert.equal(response.match(/HTTP\/1\.1 200 /g)?.length, 261)
      assert.match(response, /\r\n\r\n"answer"$/)
    } finally {
      await running.stop({ drainMs: 0 })
    }
  },
)

test(
  "Rust answers a request whose async handler settles right after the peer closes its send side",
  nativeTest,
  async () => {
    const app = server().get("/soon", async () => {
      await Promise.resolve()
      return "soon"
    })
    const running = await serve(app, settings)
    try {
      const response = await new Promise((resolve, reject) => {
        const socket = createConnection(running.port, settings.hostname)
        const chunks = []
        socket.on("error", reject)
        socket.setTimeout(3000, () => socket.destroy(new Error("response timed out")))
        socket.on("data", (chunk) => chunks.push(chunk))
        socket.on("end", () => resolve(Buffer.concat(chunks).toString()))
        socket.on("connect", () => socket.end("GET /soon HTTP/1.1\r\nHost: localhost\r\n\r\n"))
      })
      assert.match(response, /^HTTP\/1\.1 200 /)
      assert.match(response, /\r\n\r\n"soon"$/)
      assert.match(response, /\r\ndate: \w{3}, \d\d \w{3} \d{4} \d\d:\d\d:\d\d GMT\r\n/)
    } finally {
      await running.stop({ drainMs: 0 })
    }
  },
)

test("Rust answers an HTTP/2 preface with a 505 when http2 is off", nativeTest, async () => {
  const running = await serve(
    server().get("/", () => "ok"),
    settings,
  )
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(running.port, settings.hostname)
      const chunks = []
      socket.on("error", reject)
      socket.setTimeout(3000, () => socket.destroy(new Error("response timed out")))
      socket.on("data", (chunk) => chunks.push(chunk))
      socket.on("close", () => resolve(Buffer.concat(chunks).toString()))
      socket.on("connect", () => socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"))
    })
    assert.match(response, /^HTTP\/1\.1 505 /)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

test(
  "Rust reads Content-Type from the batch exactly as the Node adapter reads it",
  nativeTest,
  async () => {
    const app = () => server().post("/u", { body: t.object({ name: t.string() }) }, (c) => c.body)
    const body = '{"name":"x"}'
    const post = (type) =>
      `POST /u HTTP/1.1\r\nHost: localhost\r\n${type}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
    const cases = {
      json: post("Content-Type: application/json\r\n"),
      charset: post("Content-Type: application/json; charset=utf-8\r\n"),
      spaced: post("Content-Type:    application/json   \r\n"),
      upper: post("CONTENT-TYPE: Application/JSON\r\n"),
      plain: post("Content-Type: text/plain\r\n"),
      plainFirst: post("Content-Type: text/plain\r\nContent-Type: application/json\r\n"),
      jsonFirst: post("Content-Type: application/json\r\nContent-Type: text/plain\r\n"),
      absent: post(""),
      empty: post("Content-Type:\r\n"),
      vendor: post("Content-Type: application/vnd.example+json\r\n"),
    }
    const status = (port, raw) =>
      new Promise((resolve, reject) => {
        const socket = createConnection(port, settings.hostname)
        let text = ""
        socket.setTimeout(3000, () => socket.destroy(new Error("response timed out")))
        socket.on("error", reject)
        socket.on("data", (chunk) => {
          text += chunk
        })
        socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1])))
        socket.on("connect", () => socket.write(raw))
      })
    const ours = await serve(app(), settings)
    const reference = await serveNode(app(), { port: 0, hostname: settings.hostname })
    try {
      for (const [name, raw] of Object.entries(cases)) {
        if (name === "plainFirst" || name === "jsonFirst") continue
        const expected = await status(reference.port, raw)
        assert.equal(
          await status(ours.port, raw),
          expected,
          `${name}: same status as @nifrajs/node`,
        )
      }
      assert.equal(await status(ours.port, cases.json), 200)
      assert.equal(
        await status(ours.port, cases.plainFirst),
        415,
        "the first Content-Type decides (the engine has always read the first; @nifrajs/node joins repeats)",
      )
      assert.equal(await status(ours.port, cases.jsonFirst), 200)
      assert.equal(await status(ours.port, cases.absent), 415)
    } finally {
      await ours.stop({ drainMs: 0 })
      await reference.stop({ drainMs: 0 })
    }
  },
)

test("Rust delivers strings and binary bodies beyond the response slab", nativeTest, async () => {
  const length = 3 * 1024 * 1024
  const app = server()
    .get("/text", () => "é".repeat(length))
    .get("/binary", () => new Response(new Uint8Array(length).fill(77)))
  const running = await serve(app, settings)
  try {
    const base = `http://${settings.hostname}:${running.port}`
    const text = await fetch(`${base}/text`)
    assert.equal(text.status, 200)
    assert.ok((await text.json()) === "é".repeat(length), "JSON string should arrive intact")
    const binary = await fetch(`${base}/binary`)
    const bytes = new Uint8Array(await binary.arrayBuffer())
    assert.equal(binary.status, 200)
    assert.equal(bytes.byteLength, length)
    assert.ok(bytes.every((byte) => byte === 77))
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

test("forced shutdown aborts requests still waiting for a response", nativeTest, async () => {
  const started = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  const running = await serve(
    {
      fetch(request) {
        const response = Promise.withResolvers()
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve()
            response.resolve(new Response(null))
          },
          { once: true },
        )
        started.resolve()
        return response.promise
      },
    },
    settings,
  )
  try {
    const result = fetch(`http://${settings.hostname}:${running.port}`).catch((error) => error)
    await started.promise
    await running.stop({ drainMs: 0 })
    await aborted.promise
    assert.ok((await result) instanceof Error)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

function converse(port, send, done) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, settings.hostname)
    let received = ""
    socket.setTimeout(5000, () => socket.destroy(new Error("exchange timed out")))
    socket.on("error", reject)
    socket.on("data", (chunk) => {
      received += chunk
      if (done(received)) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on("close", () => resolve(received))
    socket.on("connect", () => send(socket))
  })
}

const bodies = (wire) => [...wire.matchAll(/\r\n\r\n("[a-z0-9]+")/g)].map((match) => match[1])

test("Rust answers pipelined requests in request order", nativeTest, async () => {
  const release = Promise.withResolvers()
  const app = server()
    .get("/slow", async () => {
      await release.promise
      return "slow"
    })
    .get("/fast", () => {
      // The slow handler is already waiting; it finishes only after this response exists.
      queueMicrotask(release.resolve)
      return "fast"
    })
    .get("/last", () => "last")
  const running = await serve(app, settings)
  try {
    const wire = await converse(
      running.port,
      (socket) => {
        const get = (path) => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`
        socket.write(get("/slow") + get("/fast") + get("/last"))
      },
      (received) => bodies(received).length === 3,
    )
    assert.deepEqual(bodies(wire), ['"slow"', '"fast"', '"last"'])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

test(
  "Rust keeps a connection open while its handler outlasts the idle timeout",
  nativeTest,
  async () => {
    const release = Promise.withResolvers()
    const app = server().get("/long", async () => {
      await release.promise
      return "done"
    })
    const running = await serve(app, { ...settings, engine: { idleTimeoutMs: 300 } })
    try {
      let closed = false
      const waiting = converse(
        running.port,
        (socket) => {
          socket.write("GET /long HTTP/1.1\r\nHost: localhost\r\n\r\n")
          socket.on("close", () => {
            closed = true
          })
        },
        (received) => received.includes('"done"'),
      )
      // A silent connection opened afterwards goes idle later than the request, so the sweep that
      // closes it has also judged the pending one.
      await new Promise((resolve) => {
        const idle = createConnection(running.port, settings.hostname)
        idle.on("error", () => {})
        idle.on("close", resolve)
      })
      assert.equal(closed, false)
      release.resolve()
      assert.match(await waiting, /^HTTP\/1\.1 200 /)
    } finally {
      await running.stop({ drainMs: 0 })
    }
  },
)

test("Rust decodes a chunked body that arrives a few bytes at a time", nativeTest, async () => {
  const app = server().post("/len", async (c) => String((await c.req.text()).length))
  const running = await serve(app, settings)
  try {
    const wire = await converse(
      running.port,
      async (socket) => {
        socket.write("POST /len HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n")
        for (let i = 0; i < 400; i++) {
          socket.write("3\r\nabc\r\n")
          await new Promise((resolve) => setImmediate(resolve))
        }
        socket.write("0\r\n\r\n")
      },
      (received) => received.includes('"1200"'),
    )
    assert.match(wire, /^HTTP\/1\.1 200 /)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

test("Rust refuses malformed and endless chunk framing", nativeTest, async () => {
  const app = server().post("/sink", () => "ok")
  const running = await serve(app, settings)
  try {
    const head = "POST /sink HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n"
    const refused = (frame) =>
      converse(
        running.port,
        (socket) => socket.write(head + frame),
        (received) => received.includes("\r\n\r\n"),
      )
    assert.match(await refused(`1;${"a".repeat(5000)}`), /^HTTP\/1\.1 400 /)
    assert.match(await refused("+5\r\nhello\r\n0\r\n\r\n"), /^HTTP\/1\.1 400 /)
    assert.match(await refused("5\r\nhello\r\n0\r\n\r\n"), /^HTTP\/1\.1 200 /)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

test("Rust does not share its port unless asked to", nativeTest, async () => {
  const app = server().get("/", () => "first")
  const first = await serve(app, settings)
  try {
    await assert.rejects(serve(app, { ...settings, port: first.port }), /not available|in use/i)
  } finally {
    await first.stop({ drainMs: 0 })
  }
})

test("Rust closes connections beyond maxConnections", nativeTest, async () => {
  const app = server().get("/", () => "ok")
  const running = await serve(app, { ...settings, engine: { maxConnections: 2 } })
  const open = []
  try {
    const connect = () =>
      new Promise((resolve, reject) => {
        const socket = createConnection(running.port, settings.hostname)
        socket.on("error", () => {})
        socket.on("connect", () => resolve(socket))
        socket.on("error", reject)
      })
    const closed = (socket) => new Promise((resolve) => socket.on("close", resolve))
    open.push(await connect(), await connect())
    // The accept happens on the server's next turn; the third is shed once the first two are held.
    await new Promise((resolve) => setImmediate(resolve))
    const third = await connect()
    await closed(third)
    // A slot frees when one of the first two leaves, and a new connection is served.
    const freed = closed(open[0])
    open[0].destroy()
    await freed
    const wire = await converse(
      running.port,
      (socket) => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
      (received) => received.includes('"ok"'),
    )
    assert.match(wire, /^HTTP\/1\.1 200 /)
  } finally {
    for (const socket of open) socket.destroy()
    await running.stop({ drainMs: 0 })
  }
})

test(
  "Rust serves HTTP/2 bodies larger than the peer's flow-control window",
  nativeTest,
  async () => {
    const { connect } = await import("node:http2")
    const size = 3 * 1024 * 1024
    const app = server()
      .get("/big", () => new Response(new Uint8Array(size).fill(65)))
      .get("/stream", () => {
        let sent = 0
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent === 48) return controller.close()
              sent++
              controller.enqueue(new Uint8Array(64 * 1024).fill(66))
            },
          }),
        )
      })
    const running = await serve(app, { ...settings, http2: true })
    const client = connect(`http://${settings.hostname}:${running.port}`)
    try {
      const read = (path) =>
        new Promise((resolve, reject) => {
          const request = client.request({ ":path": path })
          const chunks = []
          request.on("data", (chunk) => chunks.push(chunk))
          request.on("end", () => resolve(Buffer.concat(chunks)))
          request.on("error", reject)
          request.end()
        })
      const big = await read("/big")
      assert.equal(big.length, size)
      assert.ok(big.every((byte) => byte === 65))
      const streamed = await read("/stream")
      assert.equal(streamed.length, 48 * 64 * 1024)
      assert.ok(streamed.every((byte) => byte === 66))
    } finally {
      client.close()
      await running.stop({ drainMs: 0 })
    }
  },
)

test("Rust closes a request that takes too long to arrive", nativeTest, async () => {
  const app = server().get("/", () => "ok")
  // The budget is spent as soon as the sweep next looks; the idle timeout is left at its default, so
  // only the request deadline can be what closes this connection.
  const running = await serve(app, { ...settings, engine: { requestTimeoutMs: 1 } })
  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection(running.port, settings.hostname)
      socket.on("error", reject)
      socket.on("close", resolve)
      socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n"))
    })
    // A request that arrives whole is unaffected.
    const wire = await converse(
      running.port,
      (socket) => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"),
      (received) => received.includes('"ok"'),
    )
    assert.match(wire, /^HTTP\/1\.1 200 /)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

test("Rust names the status in the response line", nativeTest, async () => {
  const app = server().get(
    "/moved",
    () => new Response(null, { status: 302, headers: { location: "/x" } }),
  )
  const running = await serve(app, settings)
  try {
    const wire = await converse(
      running.port,
      (socket) => socket.write("GET /moved HTTP/1.1\r\nHost: localhost\r\n\r\n"),
      (received) => received.includes("\r\n\r\n"),
    )
    assert.match(wire, /^HTTP\/1\.1 302 Found\r\n/)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})
