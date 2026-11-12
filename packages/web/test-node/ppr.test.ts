/**
 * Partially prerendered pages on Node itself, through both adapter lanes (`serve(app)`, which takes the
 * node-direct path, and `serve({ fetch })`): the shell streams before a slow hole, and a hang-up or the
 * cancel beacon aborts the hole loader still running, and behind `compression()` the gzipped shell
 * still arrives before the slow hole.
 */

import assert from "node:assert/strict"
import { once } from "node:events"
import { type IncomingMessage, request } from "node:http"
import { test } from "node:test"
import { createGunzip } from "node:zlib"
import { compression } from "@nifrajs/middleware"
import { serve } from "@nifrajs/node"
import type { BoundaryStates, Manifest, RenderAdapter, RouteModule } from "@nifrajs/web"
import { createWebApp } from "@nifrajs/web"
import { partialPrerendering } from "@nifrajs/web/ppr"

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

/** A page whose one hole waits for its signal; `signals` yields each invocation's signal. */
function appWith(signals: Array<(signal: AbortSignal) => void>) {
  // biome-ignore lint/plugin/noChainedTypeAssertions: a route module with only the fields the partially prerendered path reads.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a route module with only the fields the partially prerendered path reads.
  const page = {
    default: "page",
    shellLoader: async () => ({ title: "Tea" }),
    boundaries: [
      {
        name: "slow",
        mode: "dynamic",
        render: (data: unknown) => `slow ${String(data)}`,
        fallback: "loading",
        load: (ctx: { readonly signal: AbortSignal }) =>
          new Promise((_, reject) => {
            signals.shift()?.(ctx.signal)
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
    ppr: partialPrerendering({ shellChecks: "unchecked-development" }),
  })
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, resolve)
    req.on("error", reject)
    req.end()
  })
}

function post(port: number, path: string, body: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "text/plain" } },
      resolve,
    )
    req.on("error", reject)
    req.end(body)
  })
}

const aborted = (signal: AbortSignal): Promise<unknown> =>
  signal.aborted ? Promise.resolve() : once(signal, "abort")

const lanes = [
  ["serve(app)", (app: ReturnType<typeof appWith>) => app],
  [
    "serve({ fetch })",
    (app: ReturnType<typeof appWith>) => ({ fetch: (r: Request) => app.fetch(r) }),
  ],
] as const

for (const [lane, handler] of lanes) {
  test(`${lane}: the shell arrives before a slow hole, and a hang-up aborts the hole`, {
    timeout: 10_000,
  }, async () => {
    const seen = Promise.withResolvers<AbortSignal>()
    const app = appWith([seen.resolve])
    const handle = await serve(handler(app), { port: 0, hostname: "127.0.0.1" })
    try {
      const res = await get(handle.port, "/p")
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers["cache-control"], "private, no-store")
      const [first] = await once(res, "data")
      const shell = String(first)
      assert.match(shell, /data-nifra-hole="slow"/)
      assert.doesNotMatch(shell, /nifra-ppr:slow/)
      const signal = await seen.promise
      assert.equal(signal.aborted, false)
      res.destroy()
      await aborted(signal)
    } finally {
      await handle.stop()
    }
  })

  test(`${lane}: behind compression(), the gzipped shell arrives before a slow hole`, {
    timeout: 10_000,
  }, async () => {
    const seen = Promise.withResolvers<AbortSignal>()
    const app = appWith([seen.resolve])
    app.use(compression())
    const handle = await serve(handler(app), { port: 0, hostname: "127.0.0.1" })
    try {
      const res = await get(handle.port, "/p", { "accept-encoding": "gzip" })
      assert.equal(res.headers["content-encoding"], "gzip")
      const gunzip = createGunzip()
      res.pipe(gunzip)
      let text = ""
      while (!text.includes('data-nifra-hole="slow"')) {
        const [chunk] = await once(gunzip, "data")
        text += String(chunk)
      }
      assert.doesNotMatch(text, /nifra-ppr:slow/)
      const signal = await seen.promise
      assert.equal(signal.aborted, false)
      res.destroy()
      await aborted(signal)
    } finally {
      await handle.stop()
    }
  })

  test(`${lane}: the cancel beacon aborts the response that printed its token`, {
    timeout: 10_000,
  }, async () => {
    const seen = Promise.withResolvers<AbortSignal>()
    const app = appWith([seen.resolve])
    const handle = await serve(handler(app), { port: 0, hostname: "127.0.0.1" })
    try {
      const res = await get(handle.port, "/p")
      let text = ""
      while (
        !text.includes('id="nifra-ppr-req"') ||
        !text.includes("</script>", text.indexOf("nifra-ppr-req"))
      ) {
        const [chunk] = await once(res, "data")
        text += String(chunk)
      }
      const token = /"token":"([A-Za-z0-9_-]+)"/.exec(text)?.[1] ?? ""
      assert.match(token, /^[A-Za-z0-9_-]{22}$/)
      const signal = await seen.promise
      const cancel = await post(handle.port, "/__nifra/ppr/cancel", token)
      assert.equal(cancel.statusCode, 204)
      cancel.resume()
      await aborted(signal)
      res.destroy()
    } finally {
      await handle.stop()
    }
  })
}
