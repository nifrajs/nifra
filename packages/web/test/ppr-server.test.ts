import { describe, expect, test } from "bun:test"
import type { BoundaryRequestCtx, BoundaryStates } from "../src/boundary.ts"
import { createCspPolicy } from "../src/csp.ts"
import { type PprOptions, resolvePprOptions } from "../src/internal/ppr/options.ts"
import { PPR_RUNTIME, pprScriptHashes } from "../src/internal/ppr/runtime.ts"
import {
  createPprServer,
  type HoleRegistration,
  type PprRequest,
  type PprServerConfig,
  PprShellBusy,
  PprShellCold,
  PprShellUnchecked,
} from "../src/internal/ppr/server.ts"
import { notFound, redirect } from "../src/internal/render-document.ts"
import type { RenderAdapter } from "../src/render-seam.ts"

const adapter: RenderAdapter = {
  renderToStream: () => new ReadableStream(),
  hydrationHead: () => "",
  renderFragment: (ui, options) => `<p data-prefix="${options.idPrefix ?? ""}">${String(ui())}</p>`,
}

// Enough text that WebKit paints the shell early, so only the sparse-shell test warns.
const PROSE = `<p>${"Loose-leaf tea, packed by hand and shipped the same day. ".repeat(4)}</p>`

const document = (data: unknown, states: BoundaryStates): string =>
  `<!doctype html><html><head><title>t</title></head><body>${PROSE}<div id="root"><h1>${typeof data === "object" && data !== null && "title" in data ? String(data.title) : ""}</h1>${Object.keys(
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
  variations: {},
  request: new Request("https://shop.test/p/1"),
  holes,
  holeContext,
  loadShell: async () => ({ title: "Tea" }),
  renderShellDocument: async (data, states) => document(data, states),
  revalidate: undefined,
  tags: () => [],
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
const readerOf = (res: Response) => {
  if (res.body === null) throw new Error("no body")
  return res.body.getReader()
}
const readRest = async (reader: ReturnType<typeof readerOf>): Promise<string> => {
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
  test("a hole's render and fallback run inside the adapter's renderFragment", async () => {
    let rendering = false
    const ran: boolean[] = []
    const server = createPprServer(
      config({
        adapter: {
          ...adapter,
          renderFragment: (ui) => {
            rendering = true
            const html = String(ui())
            rendering = false
            return html
          },
        },
      }),
    )
    const tracked = hole("cart", () => 1, {
      render: (data: never) => {
        ran.push(rendering)
        return `cart:${data}`
      },
    })
    await (await server.respond(pprRequest([tracked]))).text()
    expect(ran).toEqual([true])
  })

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

  test("two visitors get byte-identical shells and different tokens; the shell builds once", async () => {
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

  test("a short shell is padded to the minimum before the request script; a fallback renders once", async () => {
    const fallbacks: unknown[] = []
    const server = createPprServer(
      config({
        options: resolvePprOptions({ minShellBytes: 4096 }),
        adapter: {
          ...adapter,
          renderFragment: (ui, options) => {
            if (options.idPrefix === undefined) fallbacks.push(ui())
            return `<p data-prefix="${options.idPrefix ?? ""}">${String(ui())}</p>`
          },
        },
      }),
    )
    const holes = [hole("cart", () => 1), hole("greeting", () => 2)]
    for (const path of ["/p/1", "/p/2"]) {
      const html = await (await server.respond(pprRequest(holes, { path }))).text()
      expect(new TextEncoder().encode(shellOf(html)).length).toBeGreaterThanOrEqual(4096)
      expect(shellOf(html)).toMatch(/<!-- +-->$/)
      expect(tokenOf(html)).toMatch(/^[A-Za-z0-9_-]{22}$/)
    }
    expect(fallbacks).toEqual(["loading cart", "loading greeting"])
  })

  test("a failing hole sends only the error slot; its siblings are intact", async () => {
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

  test("a hole that ignores its signal gets the error frame at its timeout; the response never waits", async () => {
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

  test("a shell that rendered a nonce is refused", async () => {
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

  test("a different deployment never reuses a shell", async () => {
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
    // At 1 a full route still builds on a key's first request, so every visit here reaches the cap.
    const server = createPprServer(
      config({ options: resolvePprOptions({ shellEntriesPerRoute: 2, shellAfterRequests: 1 }) }),
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

  describe("shellAfterRequests", () => {
    const later = (store: PprOptions = { shellEntriesPerRoute: 1 }) => {
      const built: string[] = []
      const server = createPprServer(
        config({ options: resolvePprOptions({ shellAfterRequests: 2, ...store }) }),
      )
      const request = (id: string) =>
        pprRequest([hole("x", () => 1)], {
          path: `/p/${id}`,
          loadShell: async () => {
            built.push(id)
            return { title: id, blob: "x".repeat(40_000) }
          },
        })
      return { built, server, request }
    }

    test("with room a key builds at once; in a full route its requests before the last stream whole", async () => {
      const { built, server, request } = later()
      expect(await (await server.respond(request("1"))).text()).toContain("<h1>1</h1>")
      await expect(server.respond(request("2"))).rejects.toBeInstanceOf(PprShellCold)
      expect(await (await server.respond(request("2"))).text()).toContain("<h1>2</h1>")
      expect(await (await server.respond(request("2"))).text()).toContain("<h1>2</h1>")
      // 2 took 1's place.
      await expect(server.shellData(request("1"))).rejects.toBeInstanceOf(PprShellCold)
      expect(await server.shellData(request("1"))).toMatchObject({ title: "1" })
      expect(built).toEqual(["1", "2", "1"])
    })

    test("a store whose byte budget fits no further shell counts as full", async () => {
      const { built, server, request } = later({ shellStoreBytes: 100_000 })
      await server.respond(request("1"))
      await server.respond(request("2"))
      await expect(server.respond(request("3"))).rejects.toBeInstanceOf(PprShellCold)
      expect(built).toEqual(["1", "2"])
    })

    test("forgets every waiting key at once when too many wait", async () => {
      const { server, request } = later()
      await server.respond(request("stored"))
      await server.respond(request("first")).catch(() => {})
      for (let i = 0; i < 10_000; i++) await server.respond(request(`n${i}`)).catch(() => {})
      await expect(server.respond(request("first"))).rejects.toBeInstanceOf(PprShellCold)
    })
  })

  describe("the store's byte budget", () => {
    const visitor = (server: ReturnType<typeof createPprServer>, built: string[]) => {
      return async (id: string, data: unknown = { title: id, blob: "x".repeat(40_000) }) =>
        (
          await server.respond(
            pprRequest([hole("x", () => 1)], {
              path: `/p/${id}`,
              loadShell: async () => {
                built.push(id)
                return data
              },
            }),
          )
        ).text()
    }
    const quietly = async (run: (warnings: unknown[][]) => Promise<void>) => {
      const warnings: unknown[][] = []
      const original = console.warn
      console.warn = (...args: unknown[]) => warnings.push(args)
      try {
        await run(warnings)
      } finally {
        console.warn = original
      }
    }

    test("counts what a shell's loader data holds", async () => {
      const built: string[] = []
      const server = createPprServer(
        config({ options: resolvePprOptions({ shellStoreBytes: 100_000, shellAfterRequests: 1 }) }),
      )
      const visit = visitor(server, built)
      await visit("1")
      await visit("2")
      await visit("3") // two documents fit, so 1 goes
      await visit("2")
      await visit("1")
      expect(built).toEqual(["1", "2", "3", "1"])
    })

    test("serves a shell over the whole budget without emptying the store, warning once in development", async () => {
      await quietly(async (warnings) => {
        const built: string[] = []
        const server = createPprServer(
          config({ options: resolvePprOptions({ shellStoreBytes: 100_000 }) }),
        )
        const visit = visitor(server, built)
        const big = { title: "big", blob: "x".repeat(200_000) }
        await visit("small")
        expect(await visit("big", big)).toContain("<h1>big</h1>")
        await visit("big", big)
        await visit("small")
        expect(built).toEqual(["small", "big", "big"])
        expect(warnings).toHaveLength(1)
        expect(String(warnings[0]?.[0])).toContain(
          'a shell of "product/[id]" holds more than shellStoreBytes',
        )
      })
    })

    test("keeps no shell whose loader data loops back on itself", async () => {
      await quietly(async () => {
        const built: string[] = []
        const server = createPprServer(config())
        const looped: Record<string, unknown> = { title: "looped" }
        looped.self = [looped, looped]
        const visit = visitor(server, built)
        await visit("looped", looped)
        await visit("looped", looped)
        expect(built).toEqual(["looped", "looped"])
      })
    })
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

  test("a hole with an empty fallback warns once per route and hole in development", async () => {
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      const server = createPprServer(
        config({
          shellChecks: "unchecked-development",
          adapter: { ...adapter, renderFragment: (ui) => String(ui()) },
        }),
      )
      const { fallback: _, ...bare } = hole("cart", () => 1)
      const blank = hole("note", () => 1, { fallback: " \n" })
      const visit = async (path: string, routeId = "product/[id]") =>
        (
          await server.respond(pprRequest([bare, blank, hole("recs", () => 1)], { path, routeId }))
        ).text()
      await visit("/p/1")
      await visit("/p/2")
      await visit("/q/1", "other")
      expect(warnings.map((args) => String(args[0]))).toEqual([
        expect.stringContaining('hole "cart" of "product/[id]" has an empty fallback'),
        expect.stringContaining('hole "note" of "product/[id]" has an empty fallback'),
        expect.stringContaining('hole "cart" of "other" has an empty fallback'),
        expect.stringContaining('hole "note" of "other" has an empty fallback'),
      ])
    } finally {
      console.warn = original
    }
  })

  test("a shell too sparse for WebKit to paint early warns once per route in development", async () => {
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      const server = createPprServer(config({ shellChecks: "unchecked-development" }))
      const sparse = (path: string) =>
        pprRequest([hole("cart", () => 1)], {
          path,
          renderShellDocument: async (data, states) => document(data, states).replace(PROSE, ""),
        })
      await (await server.respond(sparse("/p/1"))).text()
      await (await server.respond(sparse("/p/2"))).text()
      await (await server.respond(pprRequest([hole("cart", () => 1)], { routeId: "rich" }))).text()
      expect(warnings).toHaveLength(1)
      expect(String(warnings[0]?.[0])).toContain('the shell of "product/[id]" has 15 characters')
    } finally {
      console.warn = original
    }
  })
})

describe("PPR shell cache (6.3, 6.4)", () => {
  const clock = () => {
    let at = 1_000_000
    return {
      now: () => at,
      advance(ms: number) {
        at += ms
      },
    }
  }
  const titleOf = (html: string): string => /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? ""

  test("a notFound() shell is cached for its TTL and starts no hole while cached", async () => {
    const time = clock()
    const server = createPprServer(config({ now: time.now }))
    let builds = 0
    let holeCalls = 0
    const request = pprRequest(
      [
        hole("cart", () => {
          holeCalls++
          return 1
        }),
      ],
      {
        loadShell: async () => {
          builds++
          notFound()
        },
      },
    )
    const first = await server.respond(request).catch((error: unknown) => error)
    expect(first).toBeInstanceOf(Response)
    expect(first instanceof Response ? first.status : 0).toBe(404)
    const callsAfterMiss = holeCalls
    const again = await server.respond(request).catch((error: unknown) => error)
    expect(again).toBe(first)
    expect(builds).toBe(1)
    expect(holeCalls).toBe(callsAfterMiss)
    time.advance(60_000)
    await server.respond(request).catch(() => {})
    expect(builds).toBe(2)
  })

  test("a stale shell is served while one rebuild runs behind it", async () => {
    const time = clock()
    const server = createPprServer(config({ now: time.now }))
    const counter = { builds: 0 }
    const release = gate()
    let held = false
    const request = pprRequest([hole("cart", () => 1)], {
      revalidate: 10,
      loadShell: async () => {
        counter.builds++
        if (held) await release.promise
        return { title: `build ${counter.builds}` }
      },
    })
    expect(titleOf(await (await server.respond(request)).text())).toBe("build 1")
    time.advance(5_000)
    expect(titleOf(await (await server.respond(request)).text())).toBe("build 1")
    expect(counter.builds).toBe(1)

    time.advance(6_000)
    held = true
    const stale = await Promise.all([server.respond(request), server.respond(request)])
    for (const res of stale) expect(titleOf(await res.text())).toBe("build 1")
    expect(counter.builds).toBe(2)
    release.release()
    await tick()
    expect(titleOf(await (await server.respond(request)).text())).toBe("build 2")
  })

  test("a failing rebuild keeps the stale shell, backs off, and gives up at the stale limit", async () => {
    const time = clock()
    const server = createPprServer(
      config({
        now: time.now,
        options: resolvePprOptions({ staleOnErrorFactor: 2, maxStaleOnErrorSeconds: 100 }),
      }),
    )
    let builds = 0
    let failing = false
    const request = pprRequest([hole("cart", () => 1)], {
      revalidate: 10,
      loadShell: async () => {
        builds++
        if (failing) throw new Error("password=hunter2")
        return { title: "fresh" }
      },
    })
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      await (await server.respond(request)).text()
      failing = true
      time.advance(11_000)
      expect(titleOf(await (await server.respond(request)).text())).toBe("fresh")
      await tick()
      expect(builds).toBe(2)
      time.advance(1_000)
      await (await server.respond(request)).text()
      expect(builds).toBe(2) // backing off: the first retry waits 2 s
      time.advance(1_500)
      await (await server.respond(request)).text()
      await tick()
      expect(builds).toBe(3)
      expect(JSON.stringify(errors).includes("hunter2")).toBe(false)

      // revalidate 10 + min(10 * 2, 100) = 30 s: past it the stale shell is dropped.
      time.advance(20_000)
      await expect(server.respond(request)).rejects.toThrow("password=hunter2")
    } finally {
      console.error = original
    }
  })

  test("over the build limit a route's next miss is refused; the same key shares one build", async () => {
    const server = createPprServer(
      config({ options: resolvePprOptions({ shellBuildConcurrency: 1 }) }),
    )
    const release = gate()
    let builds = 0
    const at = (path: string) =>
      pprRequest([hole("cart", () => 1)], {
        path,
        loadShell: async () => {
          builds++
          await release.promise
          return { title: path }
        },
      })
    const first = server.respond(at("/p/1"))
    const same = server.respond(at("/p/1"))
    await expect(server.respond(at("/p/2"))).rejects.toBeInstanceOf(PprShellBusy)
    release.release()
    await Promise.all([(await first).text(), (await same).text()])
    expect(builds).toBe(1)
    await (await server.respond(at("/p/2"))).text()
    expect(builds).toBe(2)
  })

  test("invalidating a tag drops its shells, and a build that started before is not stored", async () => {
    const server = createPprServer(config())
    const counter = { builds: 0 }
    const release = gate()
    let held = false
    const request = pprRequest([hole("cart", () => 1)], {
      tags: () => ["product:1"],
      loadShell: async () => {
        counter.builds++
        if (held) await release.promise
        return { title: `build ${counter.builds}` }
      },
    })
    await (await server.respond(request)).text()
    server.invalidateTag("other")
    await (await server.respond(request)).text()
    expect(counter.builds).toBe(1)
    server.invalidateTag("product:1")
    held = true
    const racing = server.respond(request)
    await tick()
    server.invalidateTag("product:1")
    release.release()
    expect(titleOf(await (await racing).text())).toBe("build 2")
    held = false
    expect(titleOf(await (await server.respond(request)).text())).toBe("build 3")
  })

  test("an on-demand build sees no async context of the request that triggered it", async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks")
    const visitor = new AsyncLocalStorage<string>()
    const server = createPprServer(config())
    let seen: string | undefined = "unset"
    const request = pprRequest([hole("cart", () => 1)], {
      loadShell: async () => {
        seen = visitor.getStore()
        return { title: "t" }
      },
    })
    await visitor.run("visitor-1", async () => (await server.respond(request)).text())
    expect(seen).toBeUndefined()
  })

  test("each declared variation is its own shell; the key does not depend on declaration order", async () => {
    let builds = 0
    const server = createPprServer(config())
    const at = (variations: Readonly<Record<string, string>>) =>
      pprRequest([hole("cart", () => 1)], {
        variations,
        loadShell: async () => {
          builds++
          return { title: JSON.stringify(variations) }
        },
      })
    await (await server.respond(at({ color: "red", size: "l" }))).text()
    await (await server.respond(at({ size: "l", color: "red" }))).text()
    expect(builds).toBe(1)
    await (await server.respond(at({ color: "blue", size: "l" }))).text()
    await (await server.respond(at({}))).text()
    expect(builds).toBe(3)
  })
})

describe("PPR server: what a hole cannot do, and when its slot frees", () => {
  test("a hole that returns or throws a redirect or a status gets its error frame and no header", async () => {
    const server = createPprServer(config())
    const original = console.error
    console.error = () => {}
    try {
      const holes = [
        hole("thrown", () => {
          throw redirect("/login")
        }),
        hole("returned", () => redirect("/login")),
        hole("missing", () => notFound()),
        hole("cart", () => 2),
      ]
      const res = await server.respond(pprRequest(holes))
      const html = await res.text()
      expect(res.status).toBe(200)
      expect(res.headers.get("location")).toBeNull()
      expect(frames(html)).toEqual({
        thrown: ERROR_FRAME,
        returned: ERROR_FRAME,
        missing: ERROR_FRAME,
        cart: { v: 1, html: '<p data-prefix="nifra-cart-">cart:2</p>' },
      })
      const states = await server.holeStates(
        pprRequest(holes),
        "settled",
        new AbortController().signal,
      )
      expect(
        Object.fromEntries(Object.entries(states).map(([name, state]) => [name, state.status])),
      ).toEqual({ thrown: "error", returned: "error", missing: "error", cart: "ready" })
    } finally {
      console.error = original
    }
  })

  test("a client that stops reading keeps its slot while a hole runs, and frees it once they settle", async () => {
    const server = createPprServer(config({ options: resolvePprOptions({ maxHoleWork: 1 }) }))
    const held = gate()
    const idle = readerOf(await server.respond(pprRequest([hole("cart", () => held.promise)])))
    await idle.read()
    const shed = await (await server.respond(pprRequest([hole("cart", () => 1)]))).text()
    expect(frames(shed)).toEqual({ cart: ERROR_FRAME })
    held.release(2)
    await tick()
    await tick()
    // Its frame waits unread in its own queue, and the slot is already free.
    expect(server.stats()).toMatchObject({ slotsInUse: 0 })
    expect(server.stats().unsentBytes).toBeGreaterThan(0)
    const served = await (await server.respond(pprRequest([hole("cart", () => 1)]))).text()
    expect(frames(served)).toEqual({
      cart: { v: 1, html: '<p data-prefix="nifra-cart-">cart:1</p>' },
    })
    await idle.cancel()
  })

  test("a shell build that fails aborts the holes started beside it; their slot frees once", async () => {
    // No grace: a loader still running after its abort counts as abandoned at once, freeing the slot.
    const server = createPprServer(
      config({ options: resolvePprOptions({ maxHoleWork: 1, abandonGraceMs: 0 }) }),
    )
    const held = gate()
    let signal: AbortSignal | undefined
    const holes = [
      hole("cart", (ctx) => {
        signal = ctx.signal
        return held.promise
      }),
    ]
    await expect(
      server.respond(
        pprRequest(holes, {
          loadShell: async () => {
            throw new Error("catalog down")
          },
        }),
      ),
    ).rejects.toThrow("catalog down")
    expect(signal?.aborted).toBe(true)
    await tick()
    expect(server.stats()).toMatchObject({ slotsInUse: 0, shed: 0, abandoned: 1 })
    const original = console.warn
    console.warn = () => {}
    try {
      held.release(1)
      await tick()
    } finally {
      console.warn = original
    }
    expect(server.stats()).toMatchObject({ slotsInUse: 0, abandoned: 0 })
    const served = await (await server.respond(pprRequest([hole("cart", () => 1)]))).text()
    expect(frames(served)).toEqual({
      cart: { v: 1, html: '<p data-prefix="nifra-cart-">cart:1</p>' },
    })
  })
})

describe("PPR server outside the request", () => {
  test("a server made inside a visitor's async context builds its shells outside it", async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks")
    const visitor = new AsyncLocalStorage<string>()
    const seen: unknown[] = []
    const server = visitor.run("first visitor", () => createPprServer(config()))
    const request = pprRequest([hole("cart", () => "c")], {
      loadShell: async () => {
        seen.push(visitor.getStore())
        return { title: "Tea" }
      },
    })
    await visitor.run("second visitor", async () => (await server.respond(request)).text())
    expect(seen).toEqual([undefined])
  })

  test("with the cancel beacon off, the request script names no address", async () => {
    const server = createPprServer(config({ options: resolvePprOptions({ cancelBeacon: false }) }))
    const html = await (await server.respond(pprRequest([hole("cart", () => "c")]))).text()
    expect(html).toContain('"cancel":""')
    expect(html).not.toContain("/__nifra/ppr/cancel")
  })
})
