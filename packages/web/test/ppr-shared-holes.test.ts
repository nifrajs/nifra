import { describe, expect, spyOn, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import type { BoundaryRequestCtx, BoundaryStates, ShellCtx } from "../src/boundary.ts"
import { rawHref } from "../src/href.ts"
import { type PprOptions, resolvePprOptions } from "../src/internal/ppr/options.ts"
import {
  createPprServer,
  type DynamicHole,
  type HoleRegistration,
  type PprRequest,
  type PprServerConfig,
  type SharedHole,
} from "../src/internal/ppr/server.ts"
import { sharedShellStore } from "../src/internal/ppr/shell-store.ts"
import { redirect } from "../src/internal/render-document.ts"
import { type CachedResponse, type CacheStore, MemoryCacheStore } from "../src/isr.ts"
import type { RenderAdapter } from "../src/render-seam.ts"

const adapter: RenderAdapter = {
  renderToStream: () => new ReadableStream(),
  hydrationHead: () => "",
  renderFragment: (ui, options) => `<p data-prefix="${options.idPrefix ?? ""}">${String(ui())}</p>`,
}

const PROSE = `<p>${"Loose-leaf tea, packed by hand and shipped the same day. ".repeat(4)}</p>`

const document = (data: unknown, states: BoundaryStates): string =>
  `<!doctype html><html><head><title>t</title></head><body>${PROSE}<h1>${JSON.stringify(data)}</h1>${Object.keys(
    states,
  )
    .map((name) => `<div data-nifra-hole="${name}" aria-busy="true"></div>`)
    .join("")}</body></html>`

type Gate = { readonly promise: Promise<unknown>; release(value?: unknown): void }
const gate = (): Gate => {
  let release!: (value?: unknown) => void
  const promise = new Promise<unknown>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const dynamic = (name: string, load: (ctx: BoundaryRequestCtx) => unknown): DynamicHole => ({
  name,
  mode: "dynamic",
  render: (data: never) => `${name}:${JSON.stringify(data)}`,
  fallback: `loading ${name}`,
  load,
})

const shared = (
  name: string,
  load: (ctx: ShellCtx) => unknown,
  extra: Partial<SharedHole> = {},
): SharedHole => ({
  name,
  mode: "shared",
  render: (data: never) => `${name}:${JSON.stringify(data)}`,
  fallback: `loading ${name}`,
  load,
  revalidate: 60,
  ...extra,
})

interface Counts {
  shells: number
}

const pprRequest = (
  holes: readonly HoleRegistration[],
  overrides: Partial<PprRequest> & { readonly cookie?: string; readonly counts?: Counts } = {},
): PprRequest => {
  const { cookie, counts, ...rest } = overrides
  const request = new Request("https://shop.test/p/1", {
    headers: cookie === undefined ? {} : { cookie },
  })
  return {
    routeId: "product/[id]",
    path: "/p/1",
    locale: undefined,
    variations: {},
    request,
    holes,
    holeContext: {
      request,
      params: { id: "1" },
      api: undefined,
      env: undefined,
      draft: false,
      search: {},
    },
    shellContext: {
      phase: "shell",
      params: { id: "1" },
      locale: undefined,
      variations: {},
      api: undefined,
    },
    loadShell: async () => {
      if (counts !== undefined) counts.shells++
      return { title: "Tea" }
    },
    renderShellDocument: async (data, states) => document(data, states),
    revalidate: undefined,
    tags: () => [],
    holeTags: (hole) =>
      typeof hole.revalidateTags === "function" ? [] : (hole.revalidateTags ?? []),
    ...rest,
  }
}

const config = (
  overrides: Partial<PprServerConfig> & { readonly pprOptions?: PprOptions } = {},
): PprServerConfig => {
  const { pprOptions, ...rest } = overrides
  return {
    options: resolvePprOptions(pprOptions),
    adapter,
    deployment: "d1",
    cancelUrl: "/__nifra/ppr/cancel",
    shellChecks: {
      v: 1,
      deployment: "d1",
      routes: { "product/[id]": "h1" },
      sharedHoles: { "product/[id]": ["price", "stock"] },
    },
    ...rest,
  }
}

const clock = () => {
  let at = 1_000_000
  return {
    now: () => at,
    advance(ms: number) {
      at += ms
    },
  }
}

const REQUEST_SCRIPT = '<script type="application/json" id="nifra-ppr-req">'

/** Hole `name`'s frame: its inert JSON script and its invoker. */
const frameOf = (html: string, name: string): string => {
  const start = html.indexOf(`<script type="application/json" id="nifra-ppr:${name}">`)
  if (start === -1) return ""
  const invoker = html.indexOf("<script>", start)
  return html.slice(start, html.indexOf("</script>", invoker) + "</script>".length)
}

const frameJson = (html: string, name: string): unknown => {
  const frame = frameOf(html, name)
  const body = frame.slice(frame.indexOf(">") + 1, frame.indexOf("</script>"))
  return body === "" ? undefined : JSON.parse(body)
}

const ERROR_FRAME = {
  v: 1,
  error: true,
  html: '<p data-nifra-hole-error="">This section is unavailable.</p>',
}

/** The response's first chunk: the shell, and every shared frame this process held. */
const firstChunk = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader()
  const first = await reader?.read()
  await reader?.cancel()
  return new TextDecoder().decode(first?.value)
}

describe("PPR shared holes", () => {
  test("built once and written with the shell, the frame is byte-identical for every visitor", async () => {
    const counts: Counts = { shells: 0 }
    const contexts: ShellCtx[] = []
    let loads = 0
    const price = shared("price", (ctx) => {
      loads++
      contexts.push(ctx)
      return { amount: 12 }
    })
    const server = createPprServer(config())
    const ada = await (
      await server.respond(
        pprRequest([price, dynamic("cart", () => 1)], { counts, cookie: "u=ada" }),
      )
    ).text()
    const bob = await firstChunk(
      await server.respond(
        pprRequest([price, dynamic("cart", () => 1)], { counts, cookie: "u=bob" }),
      ),
    )
    expect(loads).toBe(1)
    expect(counts.shells).toBe(1)
    // A hit goes out in the shell's own chunk, before the per-visitor holes.
    expect(bob.indexOf(frameOf(bob, "price"))).toBeGreaterThan(bob.indexOf(REQUEST_SCRIPT))
    expect(frameOf(bob, "price")).toBe(frameOf(ada, "price"))
    expect(frameJson(ada, "price")).toEqual({
      v: 1,
      html: '<p data-prefix="nifra-price-">price:{"amount":12}</p>',
    })
    // The loader gets the shell's context and its own key collector: no request, cookies, env or draft.
    expect(Object.keys(contexts[0] ?? {}).sort()).toEqual([
      "api",
      "live",
      "locale",
      "params",
      "phase",
      "signal",
      "variations",
    ])
    expect(ada).toContain('"shared":["price"]')
  })

  test("its build sees no visitor's async context", async () => {
    const visitor = new AsyncLocalStorage<string>()
    const seen: unknown[] = []
    const price = shared("price", () => {
      seen.push(visitor.getStore())
      return 1
    })
    const server = createPprServer(config())
    const html = await visitor.run("ada", async () =>
      (await server.respond(pprRequest([price]))).text(),
    )
    expect(frameJson(html, "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:1</p>',
    })
    expect(seen).toEqual([undefined])
  })

  test("a miss past the hole's timeout gets the error frame; the build goes on for the next visitor", async () => {
    const release = gate()
    let loads = 0
    const price = shared(
      "price",
      async () => {
        loads++
        await release.promise
        return { amount: 3 }
      },
      { timeout: 20 },
    )
    const server = createPprServer(config())
    const first = await (await server.respond(pprRequest([price]))).text()
    expect(frameJson(first, "price")).toEqual(ERROR_FRAME)
    release.release()
    const second = await server.respond(pprRequest([price]))
    // The build may still be settling: the second visitor waits on it, never starting another.
    const text = await second.text()
    expect(frameJson(text, "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"amount":3}</p>',
    })
    expect(loads).toBe(1)
  })

  test("a build whose loader ignores its signal keeps nothing past maxHoleTimeoutMs; the next visitor builds again", async () => {
    const never = gate()
    let loads = 0
    let seen: AbortSignal | undefined
    const price = shared(
      "price",
      async (ctx) => {
        loads++
        if (loads > 1) return { amount: 4 }
        seen = ctx.signal
        await never.promise
        return { amount: 3 }
      },
      { timeout: 10 },
    )
    const server = createPprServer(
      config({ pprOptions: { holeTimeoutMs: 10, maxHoleTimeoutMs: 30 } }),
    )
    const first = await (await server.respond(pprRequest([price]))).text()
    expect(frameJson(first, "price")).toEqual(ERROR_FRAME)
    const signal = seen
    if (signal === undefined) throw new Error("the build never started")
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve))
    never.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await (await server.respond(pprRequest([price]))).text()
    expect(frameJson(second, "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"amount":4}</p>',
    })
    expect(loads).toBe(2)
  })

  test("its own revalidate refreshes it behind the stale frame, without a shell rebuild", async () => {
    const time = clock()
    const counts: Counts = { shells: 0 }
    let loads = 0
    const price = shared("price", () => ({ build: ++loads }), { revalidate: 10 })
    const server = createPprServer(config({ now: time.now }))
    await (await server.respond(pprRequest([price], { counts }))).text()
    time.advance(11_000)
    const rebuilds: Promise<unknown>[] = []
    const stale = await (
      await server.respond(
        pprRequest([price], { counts, waitUntil: (promise) => rebuilds.push(promise) }),
      )
    ).text()
    expect(frameJson(stale, "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"build":1}</p>',
    })
    expect(rebuilds).toHaveLength(1)
    await Promise.all(rebuilds)
    const fresh = await firstChunk(await server.respond(pprRequest([price], { counts })))
    expect(frameJson(fresh, "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"build":2}</p>',
    })
    expect(loads).toBe(2)
    expect(counts.shells).toBe(1)
  })

  test("a purge by its tag drops it, and only a tag the shell shares drops the shell too", async () => {
    const counts: Counts = { shells: 0 }
    let loads = 0
    const price = shared("price", () => ({ build: ++loads }), {
      revalidateTags: ["price:1", "catalog"],
    })
    const server = createPprServer(config())
    const visit = async () =>
      (await server.respond(pprRequest([price], { counts, tags: () => ["catalog"] }))).text()
    await visit()
    await server.invalidateTag("price:1")
    expect(frameJson(await visit(), "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"build":2}</p>',
    })
    expect(counts.shells).toBe(1)
    await server.invalidateTag("catalog")
    expect(frameJson(await visit(), "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"build":3}</p>',
    })
    expect(counts.shells).toBe(2)
  })

  test("a purge that lands while only its own rebuild runs keeps that rebuild out", async () => {
    const time = clock()
    const counts: Counts = { shells: 0 }
    const paused = gate()
    let price = 10
    let loads = 0
    const hole = shared(
      "price",
      async () => {
        loads++
        const read = price
        if (loads === 2) await paused.promise
        return { amount: read }
      },
      { revalidate: 10, revalidateTags: ["price:1"] },
    )
    const server = createPprServer(config({ now: time.now }))
    await (await server.respond(pprRequest([hole], { counts }))).text()
    time.advance(11_000)
    const rebuilds: Promise<unknown>[] = []
    await (
      await server.respond(
        pprRequest([hole], { counts, waitUntil: (promise) => rebuilds.push(promise) }),
      )
    ).text()
    // The rebuild read the old price; the change and its purge land before it settles.
    price = 20
    await server.invalidateTag("price:1")
    paused.release()
    await Promise.allSettled(rebuilds)
    const after = await (await server.respond(pprRequest([hole], { counts }))).text()
    expect(counts.shells).toBe(1)
    expect(loads).toBe(3)
    expect(frameJson(after, "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"amount":20}</p>',
    })
  })

  test("a failed build is never stored: the stale frame stays, and retries back off", async () => {
    const time = clock()
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      let loads = 0
      let failing = false
      const price = shared(
        "price",
        () => {
          loads++
          if (failing) throw new Error("upstream down at db.internal:5432")
          return { build: loads }
        },
        { revalidate: 10 },
      )
      const server = createPprServer(config({ now: time.now }))
      await (await server.respond(pprRequest([price]))).text()
      failing = true
      time.advance(11_000)
      for (let visit = 0; visit < 3; visit++) {
        const html = await (await server.respond(pprRequest([price]))).text()
        expect(frameJson(html, "price")).toMatchObject({
          html: '<p data-prefix="nifra-price-">price:{"build":1}</p>',
        })
      }
      // One rebuild failed; the next waits out its backoff.
      expect(loads).toBe(2)
      expect(errors).toHaveBeenCalledWith("[nifra/web] ppr: shared hole build failed", {
        route: "product/[id]",
        hole: "price",
        kind: "error",
      })
      expect(JSON.stringify(errors.mock.calls).includes("db.internal")).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })

  test("a nonce, a redirect or a throw in a shared hole is its error frame and is not stored", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const loads = { nonce: 0, redirect: 0, thrown: 0 }
      const holes = [
        shared("nonce", () => ++loads.nonce, {
          render: () => '<span nonce="abc">x</span>',
        }),
        shared("redirect", () => {
          loads.redirect++
          return redirect(rawHref("/elsewhere"))
        }),
        shared("thrown", () => {
          loads.thrown++
          throw new Error("no")
        }),
      ]
      const server = createPprServer(
        config({
          shellChecks: {
            v: 1,
            deployment: "d1",
            routes: { "product/[id]": "h1" },
            sharedHoles: { "product/[id]": ["nonce", "redirect", "thrown"] },
          },
        }),
      )
      for (let visit = 0; visit < 2; visit++) {
        const html = await (await server.respond(pprRequest(holes))).text()
        for (const name of ["nonce", "redirect", "thrown"])
          expect(frameJson(html, name)).toEqual(ERROR_FRAME)
        expect(html.includes('nonce="abc"')).toBe(false)
      }
      expect(loads).toEqual({ nonce: 2, redirect: 2, thrown: 2 })
    } finally {
      errors.mockRestore()
    }
  })

  test("over the route's build limit a miss is still built once, under admission, and stored", async () => {
    const shellHeld = gate()
    let loads = 0
    const price = shared("price", () => ({ build: ++loads }))
    const server = createPprServer(config({ pprOptions: { shellBuildConcurrency: 1 } }))
    // The shell build takes the route's only build; the hole starts beside it.
    const first = server.respond(
      pprRequest([price], {
        loadShell: async () => {
          await shellHeld.promise
          return { title: "Tea" }
        },
      }),
    )
    const during = server.stats()
    shellHeld.release()
    await (await first).text()
    expect(during.slotsInUse).toBe(1)
    const next = await firstChunk(await server.respond(pprRequest([price])))
    expect(frameJson(next, "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"build":1}</p>',
    })
    expect(loads).toBe(1)
    expect(server.stats().slotsInUse).toBe(0)
  })

  test("over the build limit with no hole-work slot free, the hole gets its error", async () => {
    const shellHeld = gate()
    const cartHeld = gate()
    let loads = 0
    const server = createPprServer(
      config({ pprOptions: { shellBuildConcurrency: 1, maxHoleWork: 1 } }),
    )
    // One response holds the process's only slot; its shell build holds the route's only build.
    const holding = server.respond(
      pprRequest([dynamic("cart", () => cartHeld.promise)], {
        loadShell: async () => {
          await shellHeld.promise
          return { title: "Tea" }
        },
      }),
    )
    const states = await server.holeStates(
      pprRequest([shared("price", () => ++loads)], { path: "/p/2" }),
      "settled",
      new AbortController().signal,
    )
    expect(states.price).toMatchObject({ status: "error" })
    expect(loads).toBe(0)
    shellHeld.release()
    cartHeld.release()
    await (await holding).text()
  })

  test("a soft navigation gets a held entry ready, and a miss as a deferred value", async () => {
    const server = createPprServer(config())
    const price = shared("price", () => ({ amount: 9 }), { interactive: true })
    const miss = await server.holeStates(
      pprRequest([price]),
      "deferred",
      new AbortController().signal,
    )
    expect(miss.price).toMatchObject({ status: "pending" })
    // Waits on the miss's build rather than starting another.
    await server.holeStates(pprRequest([price]), "settled", new AbortController().signal)
    const hit = await server.holeStates(
      pprRequest([price]),
      "deferred",
      new AbortController().signal,
    )
    expect(hit.price).toEqual({
      name: "price",
      mode: "shared",
      status: "ready",
      data: { amount: 9 },
    })
    const html = await firstChunk(await server.respond(pprRequest([price])))
    expect(frameJson(html, "price")).toEqual({
      v: 1,
      html: '<p data-prefix="nifra-price-">price:{"amount":9}</p>',
      props: { amount: 9 },
    })
  })

  test("a draft never reads or fills a shared entry", async () => {
    let loads = 0
    const price = shared("price", () => ({ build: ++loads }))
    const server = createPprServer(config())
    const draft = (): PprRequest => {
      const base = pprRequest([price])
      return { ...base, holeContext: { ...base.holeContext, draft: true } }
    }
    const signal = new AbortController().signal
    expect((await server.holeStates(draft(), "settled", signal)).price).toMatchObject({
      data: { build: 1 },
    })
    expect((await server.holeStates(draft(), "settled", signal)).price).toMatchObject({
      data: { build: 2 },
    })
    expect((await server.holeStates(pprRequest([price]), "settled", signal)).price).toMatchObject({
      data: { build: 3 },
    })
    expect((await server.holeStates(draft(), "settled", signal)).price).toMatchObject({
      data: { build: 4 },
    })
  })

  test("a shared hole the build did not check loads for every visitor, with one warning", async () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let loads = 0
      const server = createPprServer(config())
      const unlisted = shared("ticker", () => ++loads)
      for (let visit = 0; visit < 2; visit++)
        await (await server.respond(pprRequest([unlisted]))).text()
      expect(loads).toBe(2)
      expect(
        warnings.mock.calls.filter(([message]) => String(message).includes('shared hole "ticker"')),
      ).toHaveLength(1)
    } finally {
      warnings.mockRestore()
    }
  })
})

describe("PPR shared holes in a shared store", () => {
  const SECRET = "a shell signing secret of 32+ chars"

  /** A store that keeps every value written to it. */
  const recording = (): {
    readonly store: CacheStore
    readonly written: Map<string, CachedResponse>
  } => {
    const inner = new MemoryCacheStore()
    const written = new Map<string, CachedResponse>()
    return {
      written,
      store: {
        get: (key) => inner.get(key),
        set: (key, value) => {
          written.set(key, value)
          return inner.set(key, value)
        },
        delete: (key) => inner.delete(key),
        invalidateTag: (tag) => inner.invalidateTag(tag),
        fence: () => inner.fence(),
      },
    }
  }

  const serverOn = (store: CacheStore, deployment = "d1") =>
    createPprServer(
      config({
        deployment,
        clientEntry: "d1",
        shared: sharedShellStore(store, SECRET, deployment),
      }),
    )

  test("another process serves the stored frame; another deployment builds its own; no per-visitor output is stored", async () => {
    const { store, written } = recording()
    const writes: Array<Promise<unknown>> = []
    let loads = 0
    const holes = [
      shared("price", () => ({ build: ++loads })),
      dynamic("cart", (ctx) => ({ who: ctx.request.headers.get("cookie") })),
    ]
    const request = (cookie: string) =>
      pprRequest(holes, { cookie, waitUntil: (promise) => writes.push(promise) })
    const built = await (await serverOn(store).respond(request("u=ada"))).text()
    await Promise.all(writes)
    const other = await (await serverOn(store).respond(request("u=bob"))).text()
    expect(loads).toBe(1)
    expect(frameOf(other, "price")).toBe(frameOf(built, "price"))
    const elsewhere = await (await serverOn(store, "d2").respond(request("u=eve"))).text()
    expect(frameJson(elsewhere, "price")).toMatchObject({
      html: '<p data-prefix="nifra-price-">price:{"build":2}</p>',
    })
    await Promise.all(writes)
    const keys = [...written.keys()]
    expect(keys.every((key) => key.startsWith("ppr:v1|") || key.includes("|price|"))).toBe(true)
    expect(keys.filter((key) => key.startsWith("ppr-hole:v1|"))).toHaveLength(2)
    for (const value of written.values()) {
      expect(value.body.includes("u=ada")).toBe(false)
      expect(value.body.includes("u=bob")).toBe(false)
    }
  })
})
