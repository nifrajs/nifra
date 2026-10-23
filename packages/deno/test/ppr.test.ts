/**
 * Partially prerendered pages on Deno's own server: the shell streams before a slow hole, a hang-up,
 * the hole's deadline and the cancel beacon each abort the hole loader still running, and behind
 * `compression()` the gzipped shell still arrives before the slow hole. A shell is built once and then
 * served from the store, outside every visitor's async context; listed bots get the page whole.
 */

import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { compression } from "@nifrajs/middleware"
import type { BoundaryStates, Manifest, RenderAdapter, RouteModule } from "@nifrajs/web"
import { createWebApp } from "@nifrajs/web"
import { partialPrerendering } from "@nifrajs/web/ppr"
import { type FetchHandler, serve } from "../src/index.ts"

const PROSE = "Loose leaf tea, packed by hand and shipped the same day it is weighed. ".repeat(4)

const html = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

const hosts = (states: BoundaryStates | undefined): string =>
  Object.values(states ?? {})
    .map((state) => `<div data-nifra-hole="${state.name}"></div>`)
    .join("")

const adapter: RenderAdapter = {
  renderToStream: (_chain, props) => html(`<main><p>${PROSE}</p>${hosts(props.boundaries)}</main>`),
  hydrationHead: () => "",
  renderFragment: (ui) => `<p>${String(ui())}</p>`,
}

interface Probe {
  /** Called with each hole invocation's signal; the hole waits for it to abort. */
  readonly holes: Array<(signal: AbortSignal) => void>
  /** Shell builds so far. */
  shellBuilds: number
  /** The visitor context each shell build could read. */
  readonly shellContexts: unknown[]
}

const visitor = new AsyncLocalStorage<string>()

function appWith(probe: Probe, timeout?: number) {
  // biome-ignore lint/plugin/noChainedTypeAssertions: a route module with only the fields the partially prerendered path reads.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a route module with only the fields the partially prerendered path reads.
  const page = {
    default: "page",
    shellLoader: async () => {
      probe.shellBuilds++
      probe.shellContexts.push(visitor.getStore())
      return { title: "Tea" }
    },
    boundaries: [
      {
        name: "slow",
        mode: "dynamic",
        timeout: timeout ?? 5000,
        render: (data: unknown) => `slow ${String(data)}`,
        fallback: "loading",
        load: (ctx: { readonly signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const hole = probe.holes.shift()
            if (hole === undefined) return resolve("ready")
            hole(ctx.signal)
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true })
          }),
      },
    ],
  } as unknown as RouteModule
  const manifest: Manifest = {
    routes: [{ id: "p", pattern: "/p", layoutIds: [], file: "p.tsx", load: async () => page }],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  return createWebApp({
    adapter,
    manifest,
    clientEntry: "/c.js",
    experimental: { ppr: partialPrerendering({ shellChecks: "unchecked-development" }) },
  })
}

const probeOf = (...holes: Array<(signal: AbortSignal) => void>): Probe => ({
  holes,
  shellBuilds: 0,
  shellContexts: [],
})

const aborted = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))

/** Each request runs inside a visitor's async context, as an app's request-scoped helpers would. */
const withVisitor = (app: FetchHandler): FetchHandler => ({
  fetch: (request) => visitor.run("visitor", () => app.fetch(request)),
})

/** Reads `body` until `done` holds for the decoded text so far. */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  done: (text: string) => boolean,
): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!done(text)) {
    const { value, done: ended } = await reader.read()
    if (ended) throw new Error(`the body ended before the expected text: ${text}`)
    text += decoder.decode(value, { stream: true })
  }
  return { text, reader }
}

Deno.test("ppr: the shell arrives before a slow hole, and a hang-up aborts the hole", async () => {
  const seen = Promise.withResolvers<AbortSignal>()
  const probe = probeOf(seen.resolve)
  const running = await serve(appWith(probe), { hostname: "127.0.0.1", port: 0 })
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: running.port })
  try {
    await conn.write(new TextEncoder().encode("GET /p HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"))
    const { text } = await readUntil(conn.readable, (t) => t.includes('data-nifra-hole="slow"'))
    assert.match(text, /^HTTP\/1\.1 200/)
    assert.match(text, /cache-control: private, no-store/i)
    assert.doesNotMatch(text, /nifra-ppr:slow/)
    const signal = await seen.promise
    assert.equal(signal.aborted, false)
    conn.close()
    await aborted(signal)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

Deno.test("ppr: behind compression(), the gzipped shell arrives before a slow hole", async () => {
  const seen = Promise.withResolvers<AbortSignal>()
  const app = appWith(probeOf(seen.resolve))
  app.use(compression())
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const client = new AbortController()
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/p`, {
      headers: { "accept-encoding": "gzip" },
      signal: client.signal,
    })
    assert.equal(res.headers.get("content-encoding"), "gzip")
    // Deno's fetch decodes gzip itself; the shell must come through before the hole settles.
    const { text, reader } = await readUntil(res.body ?? new ReadableStream(), (t) =>
      t.includes('data-nifra-hole="slow"'),
    )
    assert.doesNotMatch(text, /nifra-ppr:slow/)
    const signal = await seen.promise
    assert.equal(signal.aborted, false)
    client.abort()
    await reader.cancel().catch(() => undefined)
    await aborted(signal)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

Deno.test("ppr: a hole past its deadline is aborted while the visitor stays", async () => {
  const seen = Promise.withResolvers<AbortSignal>()
  const running = await serve(appWith(probeOf(seen.resolve), 20), {
    hostname: "127.0.0.1",
    port: 0,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/p`)
    const signal = await seen.promise
    await aborted(signal)
    const text = await res.text()
    assert.match(text, /nifra-ppr:slow/)
    assert.doesNotMatch(text, /slow ready/)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

Deno.test("ppr: the cancel beacon aborts the response that printed its token", async () => {
  const seen = Promise.withResolvers<AbortSignal>()
  const running = await serve(appWith(probeOf(seen.resolve)), { hostname: "127.0.0.1", port: 0 })
  const client = new AbortController()
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/p`, { signal: client.signal })
    const { text, reader } = await readUntil(
      res.body ?? new ReadableStream(),
      (t) =>
        t.includes('id="nifra-ppr-req"') && t.includes("</script>", t.indexOf("nifra-ppr-req")),
    )
    const token = /"token":"([A-Za-z0-9_-]+)"/.exec(text)?.[1] ?? ""
    assert.match(token, /^[A-Za-z0-9_-]{22}$/)
    const signal = await seen.promise
    const cancel = await fetch(`http://127.0.0.1:${running.port}/__nifra/ppr/cancel`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: token,
    })
    assert.equal(cancel.status, 204)
    await cancel.body?.cancel()
    await aborted(signal)
    client.abort()
    await reader.cancel().catch(() => undefined)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

Deno.test("ppr: one shell build serves later visitors, outside every visitor's context", async () => {
  const probe = probeOf()
  const running = await serve(withVisitor(appWith(probe)), { hostname: "127.0.0.1", port: 0 })
  try {
    for (let visit = 0; visit < 3; visit++) {
      const text = await (await fetch(`http://127.0.0.1:${running.port}/p`)).text()
      assert.match(text, /slow ready/)
    }
    assert.equal(probe.shellBuilds, 1)
    assert.deepEqual(probe.shellContexts, [undefined])
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

Deno.test("ppr: a listed bot gets the page whole, with no partial prerendering runtime", async () => {
  const running = await serve(appWith(probeOf()), { hostname: "127.0.0.1", port: 0 })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/p`, {
      headers: { "user-agent": "Twitterbot/1.0" },
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.match(text, /data-nifra-hole="slow"/)
    assert.doesNotMatch(text, /nifra-ppr/)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})
