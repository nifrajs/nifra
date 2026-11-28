// End-to-end HTTP/2 + AsyncLocalStorage isolation microbenchmark.
// usage: node packages/node-engine/bench/h2-bench.mjs
import { AsyncLocalStorage } from "node:async_hooks"
import http from "node:http"
import http2 from "node:http2"
import { performance } from "node:perf_hooks"
import { server } from "../../core/dist/index.js"
import { serve } from "../dist/index.js"

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16)
const TOTAL_REQUESTS = Number(process.env.REQUESTS ?? 4000)

async function benchH2Engine() {
  const als = new AsyncLocalStorage()
  const app = server().get("/ping", () => ({ ok: true, store: als.getStore() ?? "serve-root" }))
  const srv = await als.run("serve-root", () => serve(app, { port: 0, http2: true }))
  const client = http2.connect(`http://127.0.0.1:${srv.port}`)
  await new Promise((resolve) => client.once("connect", resolve))

  // Warmup
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve, reject) => {
      const req = client.request({ ":path": "/ping" })
      req.on("error", reject)
      req.resume()
      req.on("end", resolve)
      req.end()
    })
  }

  let completed = 0
  let inFlight = 0
  const start = performance.now()
  await new Promise((resolve, reject) => {
    const pump = () => {
      while (inFlight < CONCURRENCY && completed + inFlight < TOTAL_REQUESTS) {
        inFlight++
        const req = client.request({ ":path": "/ping" })
        req.on("error", reject)
        req.resume()
        req.on("end", () => {
          inFlight--
          completed++
          if (completed === TOTAL_REQUESTS) resolve()
          else pump()
        })
        req.end()
      }
    }
    pump()
  })
  const elapsedMs = performance.now() - start
  client.close()
  await srv.stop()
  return {
    name: "nifra-engine-h2c",
    requests: TOTAL_REQUESTS,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    rps: Math.round((TOTAL_REQUESTS / elapsedMs) * 1000),
  }
}

async function benchNodeH2() {
  const srv = http2.createServer((req, res) => {
    if (req.url === "/ping") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true,"store":"serve-root"}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve))
  const port = srv.address().port
  const client = http2.connect(`http://127.0.0.1:${port}`)
  await new Promise((resolve) => client.once("connect", resolve))

  for (let i = 0; i < 100; i++) {
    await new Promise((resolve, reject) => {
      const req = client.request({ ":path": "/ping" })
      req.on("error", reject)
      req.resume()
      req.on("end", resolve)
      req.end()
    })
  }

  let completed = 0
  let inFlight = 0
  const start = performance.now()
  await new Promise((resolve, reject) => {
    const pump = () => {
      while (inFlight < CONCURRENCY && completed + inFlight < TOTAL_REQUESTS) {
        inFlight++
        const req = client.request({ ":path": "/ping" })
        req.on("error", reject)
        req.resume()
        req.on("end", () => {
          inFlight--
          completed++
          if (completed === TOTAL_REQUESTS) resolve()
          else pump()
        })
        req.end()
      }
    }
    pump()
  })
  const elapsedMs = performance.now() - start
  client.close()
  await new Promise((resolve) => srv.close(resolve))
  return {
    name: "node-http2-h2c",
    requests: TOTAL_REQUESTS,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    rps: Math.round((TOTAL_REQUESTS / elapsedMs) * 1000),
  }
}

async function benchH1Engine() {
  const app = server().get("/ping", () => ({ ok: true }))
  const srv = await serve(app, { port: 0 })
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY })

  for (let i = 0; i < 100; i++) {
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: srv.port, path: "/ping", agent },
        (res) => {
          res.resume()
          res.on("end", resolve)
        },
      )
      req.on("error", reject)
      req.end()
    })
  }

  let completed = 0
  let inFlight = 0
  const start = performance.now()
  await new Promise((resolve, reject) => {
    const pump = () => {
      while (inFlight < CONCURRENCY && completed + inFlight < TOTAL_REQUESTS) {
        inFlight++
        const req = http.request(
          { host: "127.0.0.1", port: srv.port, path: "/ping", agent },
          (res) => {
            res.resume()
            res.on("end", () => {
              inFlight--
              completed++
              if (completed === TOTAL_REQUESTS) resolve()
              else pump()
            })
          },
        )
        req.on("error", reject)
        req.end()
      }
    }
    pump()
  })
  const elapsedMs = performance.now() - start
  agent.destroy()
  await srv.stop()
  return {
    name: "nifra-engine-h1",
    requests: TOTAL_REQUESTS,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    rps: Math.round((TOTAL_REQUESTS / elapsedMs) * 1000),
  }
}

const results = [await benchH1Engine(), await benchH2Engine(), await benchNodeH2()]
console.log(
  JSON.stringify({ concurrency: CONCURRENCY, requests: TOTAL_REQUESTS, results }, null, 2),
)
