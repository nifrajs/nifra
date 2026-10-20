import { describe, expect, test } from "bun:test"
import type { BoundaryRequestCtx, BoundaryStates } from "../src/boundary.ts"
import { createCspPolicy } from "../src/csp.ts"
import { resolvePprOptions } from "../src/internal/ppr/options.ts"
import { PPR_RUNTIME, pprScriptHashes } from "../src/internal/ppr/runtime.ts"
import {
  createPprServer,
  type HoleRegistration,
  type PprRequest,
  type PprServerConfig,
  PprShellUnchecked,
} from "../src/internal/ppr/server.ts"
import type { RenderAdapter } from "../src/render-seam.ts"

const adapter: RenderAdapter = {
  renderToStream: () => new ReadableStream(),
  hydrationHead: () => "",
  renderFragment: (ui, options) => `<p data-prefix="${options.idPrefix ?? ""}">${String(ui)}</p>`,
}

const document = (data: unknown, states: BoundaryStates): string =>
  `<!doctype html><html><head><title>t</title></head><body><div id="root"><h1>${typeof data === "object" && data !== null && "title" in data ? String(data.title) : ""}</h1>${Object.keys(
    states,
  )
    .map((name) => `<div data-nifra-hole="${name}" aria-busy="true"></div>`)
    .join(
      "",
    )}</div><script type="application/json" id="__nifra-handover">{}</script><script type="module" src="/entry.js"></script></body></html>`

type Gate = { readonly promise: Promise<unknown>; release(value?: unknown): void }
const gate = (): Gate => {
  let release!: (value?: unknown) => void
  const promise = new Promise<unknown>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const hole = (
  name: string,
  load: (ctx: BoundaryRequestCtx) => unknown,
  extra: Partial<HoleRegistration> = {},
): HoleRegistration => ({
  name,
  mode: "dynamic",
  render: (data: never) => `${name}:${JSON.stringify(data)}`,
  fallback: `loading ${name}`,
  load,
  ...extra,
})

const holeContext: Omit<BoundaryRequestCtx, "signal"> = {
  request: new Request("https://shop.test/p/1"),
  params: { id: "1" },
  api: undefined,
  env: undefined,
  draft: false,
  search: {},
}

const pprRequest = (
  holes: readonly HoleRegistration[],
  overrides: Partial<PprRequest> = {},
): PprRequest => ({
  routeId: "product/[id]",
  params: { id: "1" },
  locale: undefined,
  request: new Request("https://shop.test/p/1"),
  holes,
  holeContext,
  loadShell: async () => ({ title: "Tea" }),
  renderShellDocument: async (data, states) => document(data, states),
  ...overrides,
})

const config = (overrides: Partial<PprServerConfig> = {}): PprServerConfig => ({
  options: resolvePprOptions(),
  adapter,
  deployment: "d1",
  cancelUrl: "/__nifra/ppr/cancel",
  shellChecks: { v: 1, deployment: "d1", routes: { "product/[id]": "h1" } },
  ...overrides,
})

const frames = (html: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const match of html.matchAll(
    /<script type="application\/json" id="nifra-ppr:([a-z0-9-]+)">([\s\S]*?)<\/script>/g,
  )) {
    out[match[1] ?? ""] = JSON.parse(match[2] ?? "null")
  }
  return out
}
const shellOf = (html: string): string =>
  html.slice(0, html.indexOf('<script type="application/json" id="nifra-ppr-req">'))
const tokenOf = (html: string): string => {
  const script: { token?: string } = JSON.parse(
    /<script type="application\/json" id="nifra-ppr-req">([^<]*)<\/script>/.exec(html)?.[1] ?? "{}",
  )
  return script.token ?? ""
}

describe("PPR server", () => {
  test("the shell carries the runtime, async entry and fallbacks; holes stream as frames", async () => {
    const server = createPprServer(config())
    const res = await server.respond(
      pprRequest([
        hole("greeting", () => ({ name: "ada" })),
        hole("cart", () => ({ count: 2 }), { interactive: true }),
      ]),
    )
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("x-accel-buffering")).toBe("no")
    const html = await res.text()
    const shell = shellOf(html)
    expect(shell).toContain(`<script>${PPR_RUNTIME}</script></head>`)
    expect(shell).toContain('<script type="module" async src="/entry.js">')
    expect(shell).toContain(
      '<div data-nifra-hole="greeting" aria-busy="true"><p data-prefix="">loading greeting</p></div>',
    )
    expect(frames(html)).toEqual({
      greeting: { v: 1, html: '<p data-prefix="nifra-greeting-">greeting:{"name":"ada"}</p>' },
      cart: {
        v: 1,
        html: '<p data-prefix="nifra-cart-">cart:{"count":2}</p>',
        props: { count: 2 },
      },
    })
    expect(html.endsWith("</body></html>")).toBe(true)
  })

  test("two visitors get byte-identical shells and different tokens; the shell builds once (I1, I2)", async () => {
    let builds = 0
    const server = createPprServer(config())
    const request = pprRequest([hole("cart", () => 1)], {
      loadShell: async () => {
        builds++
        return { title: "Tea" }
      },
    })
    const [a, b] = await Promise.all([
      server.respond(request).then((r) => r.text()),
      server.respond(request).then((r) => r.text()),
    ])
    expect(builds).toBe(1)
    expect(shellOf(a)).toBe(shellOf(b))
    expect(tokenOf(a)).not.toBe(tokenOf(b))
    expect(tokenOf(a)).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(shellOf(a).includes(tokenOf(a))).toBe(false)
  })

  test("a failing hole sends only the error slot; its siblings are intact (I6)", async () => {
    const server = createPprServer(config())
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const html = await (
        await server.respond(
          pprRequest([
            hole("bad", () => {
              throw new Error("password=hunter2")
            }),
            hole("good", () => "ok"),
          ]),
        )
      ).text()
      expect(html.includes("hunter2")).toBe(false)
      expect(frames(html)).toEqual({
        bad: {
          v: 1,
          error: true,
          html: '<p data-nifra-hole-error="">This section is unavailable.</p>',
        },
        good: { v: 1, html: '<p data-prefix="nifra-good-">good:"ok"</p>' },
      })
      expect(errors).toHaveLength(1)
    } finally {
      console.error = original
    }
  })

  test("a hole that ignores its signal gets the error frame at its timeout; the response never waits (I7)", async () => {
    const server = createPprServer(config())
    let seen: AbortSignal | undefined
    const never = gate()
    const original = console.error
    console.error = () => {}
    try {
      const started = performance.now()
      const html = await (
        await server.respond(
          pprRequest([
            hole(
              "slow",
              (ctx) => {
                seen = ctx.signal
                return never.promise
              },
              { timeout: 30 },
            ),
          ]),
        )
      ).text()
      expect(performance.now() - started).toBeLessThan(1000)
      expect(frames(html)).toEqual({
        slow: {
          v: 1,
          error: true,
          html: '<p data-nifra-hole-error="">This section is unavailable.</p>',
        },
      })
      expect(seen?.aborted).toBe(true)
    } finally {
      console.error = original
      never.release()
    }
  })

  test("the cancel token and a client disconnect both abort pending loaders", async () => {
    for (const how of ["token", "disconnect"] as const) {
      const server = createPprServer(config())
      const client = new AbortController()
      const pending = gate()
      let signal: AbortSignal | undefined
      const res = await server.respond(
        pprRequest(
          [
            hole("slow", (ctx) => {
              signal = ctx.signal
              return pending.promise
            }),
          ],
          { request: new Request("https://shop.test/p/1", { signal: client.signal }) },
        ),
      )
      const reader = res.body?.getReader()
      const first = new TextDecoder().decode((await reader?.read())?.value)
      expect(signal?.aborted).toBe(false)
      if (how === "token") expect(server.cancel(tokenOf(first))).toBe(true)
      else client.abort()
      expect(signal?.aborted).toBe(true)
      expect(server.cancel(tokenOf(first))).toBe(false)
      await reader?.cancel()
      pending.release()
    }
  })

  test("body cancel aborts pending loaders and writes nothing more", async () => {
    const server = createPprServer(config())
    const pending = gate()
    let signal: AbortSignal | undefined
    const res = await server.respond(
      pprRequest([
        hole("slow", (ctx) => {
          signal = ctx.signal
          return pending.promise
        }),
      ]),
    )
    await res.body?.cancel()
    expect(signal?.aborted).toBe(true)
    pending.release()
  })

  test("a route with no passing shell check gets no shared shell (fail closed)", async () => {
    const unchecked = createPprServer(
      config({ shellChecks: { v: 1, deployment: "d1", routes: {} } }),
    )
    await expect(unchecked.respond(pprRequest([hole("a", () => 1)]))).rejects.toBeInstanceOf(
      PprShellUnchecked,
    )
    const stale = createPprServer(
      config({ shellChecks: { v: 1, deployment: "d0", routes: { "product/[id]": "h1" } } }),
    )
    await expect(stale.respond(pprRequest([hole("a", () => 1)]))).rejects.toBeInstanceOf(
      PprShellUnchecked,
    )
  })

  test("a shell that rendered a nonce is refused (I2)", async () => {
    const server = createPprServer(config())
    await expect(
      server.respond(
        pprRequest([hole("a", () => 1)], {
          renderShellDocument: async (data, states) =>
            document(data, states).replace("<title>", '<script nonce="abc"></script><title>'),
        }),
      ),
    ).rejects.toThrow("rendered a nonce into its shell")
  })

  test("a different deployment never reuses a shell (I11)", async () => {
    let builds = 0
    const loadShell = async () => {
      builds++
      return { title: "Tea" }
    }
    const store = config()
    const a = createPprServer(store)
    const b = createPprServer({
      ...store,
      deployment: "d2",
      shellChecks: { v: 1, deployment: "d2", routes: { "product/[id]": "h1" } },
    })
    await (await a.respond(pprRequest([hole("x", () => 1)], { loadShell }))).text()
    await (await b.respond(pprRequest([hole("x", () => 1)], { loadShell }))).text()
    expect(builds).toBe(2)
  })

  test("the per-route entry cap evicts that route's least recent shell", async () => {
    let builds = 0
    const server = createPprServer(
      config({ options: resolvePprOptions({ shellEntriesPerRoute: 2 }) }),
    )
    const visit = async (id: string) =>
      (
        await server.respond(
          pprRequest([hole("x", () => 1)], {
            params: { id },
            loadShell: async () => {
              builds++
              return { title: id }
            },
          }),
        )
      ).text()
    await visit("1")
    await visit("2")
    await visit("1")
    await visit("3") // evicts 2, the least recently used
    expect(builds).toBe(3)
    await visit("1")
    expect(builds).toBe(3)
    await visit("2")
    expect(builds).toBe(4)
  })

  test("under a CSP the header lists the PPR hashes and no nonce", async () => {
    const csp = createCspPolicy({
      header: ({ sources, nonce }) =>
        `script-src 'self' ${sources}${nonce === undefined ? "" : " nonce"}`,
    })
    const server = createPprServer(config({ csp }))
    const res = await server.respond(pprRequest([hole("cart", () => 1), hole("greeting", () => 2)]))
    const header = res.headers.get("content-security-policy") ?? ""
    for (const hash of await pprScriptHashes(["cart", "greeting"])) expect(header).toContain(hash)
    expect(header.includes("nonce")).toBe(false)
    await res.text()
  })
})
