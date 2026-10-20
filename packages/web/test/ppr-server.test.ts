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
  path: "/p/1",
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
const ERROR_FRAME = {
  v: 1,
  error: true,
  html: '<p data-nifra-hole-error="">This section is unavailable.</p>',
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const readerOf = (res: Response): ReadableStreamDefaultReader<Uint8Array> => {
  if (res.body === null) throw new Error("no body")
  return res.body.getReader()
}
const readRest = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder()
  let out = ""
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    out += decoder.decode(chunk.value, { stream: true })
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
    expect(shell).toContain(
      '<link rel="modulepreload" href="/entry.js"><script>__nifraPpr.boot()</script>',
    )
    expect(shell.includes('type="module"')).toBe(false)
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
      expect(JSON.stringify(errors).includes("hunter2")).toBe(false)
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
            path: `/p/${id}`,
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

describe("PPR server: admission and unsent bytes (7.3, 7.7)", () => {
  test("no free hole-work slot: every hole gets its error frame and no loader runs", async () => {
    const server = createPprServer(config({ options: resolvePprOptions({ maxHoleWork: 1 }) }))
    const held = gate()
    let invoked = 0
    const request = pprRequest([
      hole("cart", () => {
        invoked++
        return held.promise
      }),
    ])
    const first = await server.respond(request)
    const second = await (await server.respond(request)).text()
    expect(invoked).toBe(1)
    expect(frames(second)).toEqual({ cart: ERROR_FRAME })
    expect(server.stats()).toMatchObject({ shed: 1, slotsInUse: 1 })
    held.release()
    await first.text()
    expect(server.stats()).toMatchObject({ slotsInUse: 0, pending: 0 })
  })

  test("a boundary at its abandoned trip point is denied: its loader never runs, siblings do", async () => {
    const server = createPprServer(
      config({ options: resolvePprOptions({ boundaryAbandonedTrip: 1, abandonGraceMs: 0 }) }),
    )
    const never = gate()
    let slowCalls = 0
    const request = pprRequest([
      hole("slow", () => {
        slowCalls++
        return never.promise
      }),
      hole("cart", () => 2),
    ])
    await (await server.respond(request)).body?.cancel()
    await tick()
    expect(server.stats().abandonedBy).toEqual({ "product/[id]|slow": 1 })

    const html = await (await server.respond(request)).text()
    expect(slowCalls).toBe(1)
    expect(frames(html)).toEqual({
      slow: ERROR_FRAME,
      cart: { v: 1, html: '<p data-prefix="nifra-cart-">cart:2</p>' },
    })
    expect(server.stats().denied).toEqual({ stop: 0, process: 0, boundary: 1 })

    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      never.release()
      await tick()
    } finally {
      console.warn = original
    }
    expect(String(warnings[0]?.[0])).toContain('boundary "product/[id]|slow" settled')
    expect(server.stats().abandoned).toBe(0)
  })

  test("past the per-response unsent cap later holes send their error frames", async () => {
    const big = "x".repeat(1500)
    const server = createPprServer(
      config({ options: resolvePprOptions({ frameBytes: 2000, maxUnsentBytesPerResponse: 2000 }) }),
    )
    const res = await server.respond(pprRequest([hole("one", () => big), hole("two", () => big)]))
    const reader = readerOf(res)
    await reader.read()
    await tick()
    expect(server.stats().unsentBytes).toBeGreaterThan(1500)
    const rest = await readRest(reader)
    expect(frames(rest)).toEqual({
      one: { v: 1, html: `<p data-prefix="nifra-one-">one:"${big}"</p>` },
      two: ERROR_FRAME,
    })
    expect(server.stats().unsentBytes).toBe(0)
  })

  test("over the process unsent budget the response with the most queued bytes is aborted", async () => {
    const big = "x".repeat(1500)
    const server = createPprServer(
      config({
        options: resolvePprOptions({
          frameBytes: 2000,
          maxUnsentBytesPerResponse: 2000,
          maxUnsentBytes: 3000,
        }),
      }),
    )
    const request = pprRequest([hole("one", () => big)])
    const slow = readerOf(await server.respond(request))
    await slow.read()
    await tick()
    const fast = readerOf(await server.respond(request))
    await fast.read()
    await tick()
    expect(server.stats().slowAborted).toBe(1)
    await expect(slow.read()).rejects.toThrow("PPR unsent byte budget")
    expect(frames(await readRest(fast))).toEqual({
      one: { v: 1, html: `<p data-prefix="nifra-one-">one:"${big}"</p>` },
    })
    expect(server.stats().unsentBytes).toBe(0)
  })

  test("a stream its client stops reading is aborted at the total deadline plus the write grace", async () => {
    const server = createPprServer(
      config({
        options: resolvePprOptions({ holeTimeoutMs: 1, totalDeadlineSlackMs: 0, writeGraceMs: 0 }),
      }),
    )
    const never = gate()
    let signal: AbortSignal | undefined
    const res = await server.respond(
      pprRequest([
        hole("slow", (ctx) => {
          signal = ctx.signal
          return never.promise
        }),
      ]),
    )
    const reader = readerOf(res)
    await reader.read()
    if (signal?.aborted !== true)
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }))
    await tick()
    await expect(reader.read()).rejects.toThrow("PPR write grace")
    expect(server.stats().unsentBytes).toBe(0)
    never.release()
  })

  test("HEAD gets the shell's status and headers, no body, and starts no hole", async () => {
    const server = createPprServer(config())
    let invoked = 0
    const res = await server.respond(
      pprRequest(
        [
          hole("cart", () => {
            invoked++
            return 1
          }),
        ],
        { request: new Request("https://shop.test/p/1", { method: "HEAD" }) },
      ),
    )
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(invoked).toBe(0)
  })

  test("hole states: a prefetch runs nothing; a data request defers each; a blocking render awaits each", async () => {
    const server = createPprServer(config())
    let invoked = 0
    const holes = [
      hole("ok", () => {
        invoked++
        return { n: 1 }
      }),
      hole("bad", () => {
        invoked++
        throw new Error("password=hunter2")
      }),
      hole(
        "slow",
        (ctx) =>
          new Promise((_, reject) =>
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)),
          ),
        { timeout: 5 },
      ),
    ]
    const signal = new AbortController().signal
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const omitted = await server.holeStates(pprRequest(holes), "omitted", signal)
      expect(invoked).toBe(0)
      expect(omitted.ok).toEqual({ name: "ok", mode: "dynamic", status: "pending", ppr: true })

      const settled = await server.holeStates(pprRequest(holes), "settled", signal)
      expect(settled.ok).toEqual({ name: "ok", mode: "dynamic", status: "ready", data: { n: 1 } })
      const failed = { status: "error", error: { name: "Error", message: "Boundary failed" } }
      expect(settled.bad).toMatchObject(failed)
      expect(settled.slow).toMatchObject(failed)

      const deferred = await server.holeStates(pprRequest(holes), "deferred", signal)
      expect(deferred.ok?.status).toBe("pending")
      const value = (name: string): Promise<unknown> => {
        const data = deferred[name]?.data
        if (typeof data !== "object" || data === null || !("promise" in data)) throw new Error(name)
        if (!(data.promise instanceof Promise)) throw new Error(name)
        return data.promise
      }
      expect(await value("ok")).toEqual({ n: 1 })
      const rejection = await value("bad").catch((error: Error) => error.message)
      expect(rejection).toBe('[nifra/web] ppr: hole "bad" is unavailable')
      expect(await value("slow").catch((error: Error) => error.message)).toBe(
        '[nifra/web] ppr: hole "slow" is unavailable',
      )
      expect(JSON.stringify(errors).includes("hunter2")).toBe(false)
      expect(server.stats()).toMatchObject({ slotsInUse: 0, pending: 0 })
    } finally {
      console.error = original
    }
  })
})
