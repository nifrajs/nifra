/**
 * One cold sample, run in a FRESH Node (V8) process by run.ts. Node is V8 - the same engine class
 * Cloudflare Workers isolates run - so this measures the parse+compile+init+first-request cost a
 * Worker pays before it can answer, which is exactly what bundle size drives on the edge (Workers has
 * no Node bootstrap to hide it behind, unlike Lambda).
 *
 * Faithfulness + limits:
 *   - The bundle is compiled in a fresh `vm` context, so top-level module init runs against a clean
 *     global exactly as a new isolate would. A fresh PROCESS per sample means V8 has never seen this
 *     source, so the compile is a genuine first-compile, not a cache hit.
 *   - It is still a proxy, not workerd: V8's compiler infrastructure is already warm in this process
 *     (as it is on a warm Cloudflare edge node spinning a fresh isolate), and the host provides the
 *     Web globals rather than workerd. Read the DELTA between rows, not the absolute.
 *
 *   node _measure.mjs <bundle.js> cold
 */
import { readFileSync } from "node:fs"
import vm from "node:vm"

const bundlePath = process.argv[2]
if (!bundlePath) throw new Error("usage: node _measure.mjs <bundle.js> cold")
const src = readFileSync(bundlePath, "utf8")

// The Web globals a Worker isolate exposes. Provided by the host here; a real isolate ships its own.
const sandbox = {
  Request,
  Response,
  Headers,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  ReadableStream,
  WritableStream,
  TransformStream,
  AbortController,
  AbortSignal,
  structuredClone,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance,
  console,
  crypto: globalThis.crypto,
  atob,
  btoa,
  process,
  module: { exports: {} },
}
sandbox.globalThis = sandbox
sandbox.self = sandbox
sandbox.exports = sandbox.module.exports
const context = vm.createContext(sandbox)

// COMPILE - V8 parse + bytecode gen for a never-before-seen script. The dominant cold-start term.
const t0 = performance.now()
const script = new vm.Script(src, { filename: bundlePath })
const compileMs = performance.now() - t0

// INIT - run the module body: every import's top-level init, the app build, adapter wiring.
const t1 = performance.now()
script.runInContext(context)
const initMs = performance.now() - t1

const handler = sandbox.module.exports?.default ?? sandbox.exports?.default
if (!handler || typeof handler.fetch !== "function") {
  throw new Error(`bundle default export has no fetch(): ${bundlePath}`)
}

// FIRST REQUEST - the isolate's first answered request, cold code paths, no JIT tier-up yet.
const request = new Request("http://bench.example/users/123", { method: "GET" })
const ctx = { waitUntil() {}, passThroughOnException() {} }
const t2 = performance.now()
// `await` on a non-thenable is a no-op, and it resolves a promise from ANY realm - the vm context has
// its own `Promise`, so a host `instanceof Promise` check would miss an async handler's return.
const res = await handler.fetch(request, {}, ctx)
const firstFetchMs = performance.now() - t2
if (!res || res.status !== 200) {
  throw new Error(`cold request was not 200 (got ${res && res.status}): ${bundlePath}`)
}

console.log(
  JSON.stringify({ compileMs, initMs, firstFetchMs, coldMs: compileMs + initMs + firstFetchMs }),
)
