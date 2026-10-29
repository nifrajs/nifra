import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BoundaryRegistration } from "../src/boundary.ts"
import { DRAFT_COOKIE, enableDraft } from "../src/draft.ts"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { type CachedResponse, type CacheStore, withISR } from "../src/isr.ts"
import { checkShellCanaries, partialPrerendering } from "../src/ppr.ts"
import { DATA_HEADER, HOLE_FILL_HEADER, KEEP_HOLES_HEADER, PREFETCH_HEADER } from "../src/router.ts"
import { nextSlowAbort, probe, releaseHeld } from "./fixtures/ppr/app/lib/probe.ts"
import { DRAFT_SECRET, type PprApp, startPprApp } from "./fixtures/ppr/app/server.ts"

let app: PprApp
beforeAll(async () => {
  app = await startPprApp()
})
afterAll(async () => {
  await app.stop()
})

/** A streamed document up to its per-response script: the bytes every visitor shares. */
const shellOf = (html: string): string =>
  html.slice(0, html.indexOf('<script type="application/json" id="nifra-ppr-req">'))

const draftCookie = async (): Promise<string> => {
  let value = ""
  await enableDraft(
    {
      set: {
        cookie: (_name, signed) => {
          value = signed
        },
        deleteCookie: () => {},
      },
    },
    DRAFT_SECRET,
  )
  return `${DRAFT_COOKIE}=${value}`
}

const firstLine = (text: string): { readonly boundaries?: Record<string, unknown> } =>
  JSON.parse(text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n")))

describe("PPR app: requests that are not a streamed document", () => {
  test("a route without a passing shell check renders whole and warns once", async () => {
    const unchecked = (text: string) => text.includes('route "leaky/[id]" has no passing shell')
    const before = app.warnings.filter(unchecked).length
    for (const id of ["1", "2"]) {
      const html = await (await fetch(`${app.origin}/leaky/${id}`)).text()
      expect(html).toContain('id="leaky"')
      expect(html).toContain('<p id="note">note</p>')
      expect(html).not.toContain('id="nifra-ppr-req"')
    }
    expect(app.warnings.filter(unchecked).length - before).toBeLessThanOrEqual(1)
    expect(app.warnings.some(unchecked)).toBe(true)
  })

  test("a prefetch gets the shell data and empty hosts, and starts no hole", async () => {
    const before = probe.slowStarted
    const res = await fetch(`${app.origin}/p/7`, {
      headers: { [DATA_HEADER]: "1", [PREFETCH_HEADER]: "1" },
    })
    const payload = firstLine(await res.text())
    expect(probe.slowStarted).toBe(before)
    expect(payload.boundaries?.slow).toEqual({
      name: "slow",
      mode: "dynamic",
      status: "pending",
      ppr: true,
    })
  })

  test("a data request runs its holes as deferred values the request's abort cancels", async () => {
    const started = probe.slowStarted
    const client = new AbortController()
    const res = await fetch(`${app.origin}/p/7?slow=60000`, {
      headers: { [DATA_HEADER]: "1" },
      signal: client.signal,
    })
    const reader = res.body?.getReader()
    const head = new TextDecoder().decode((await reader?.read())?.value)
    expect(probe.slowStarted).toBe(started + 1)
    expect(firstLine(head).boundaries?.slow).toMatchObject({ status: "pending" })
    const aborted = nextSlowAbort()
    client.abort()
    await aborted
  })

  test("a listed bot gets the blocking render with every hole filled", async () => {
    const res = await fetch(`${app.origin}/p/7`, { headers: { "user-agent": "Slackbot 1.0" } })
    const html = await res.text()
    expect(html).toContain('<p id="slow">slow <!-- -->50</p>')
    expect(html).toContain('id="cart"')
    expect(html.includes("nifra-ppr:")).toBe(false)
  })

  test("a shell gets the configured origin, never the request's Host", async () => {
    const res = await fetch(`${app.origin}/p/8`, { headers: { host: "evil.example" } })
    const html = await res.text()
    expect(probe.shellOrigin).toBe("https://shop.example")
    expect(html).toContain('<link rel="canonical" href="https://shop.example/p/8"')
    expect(html.includes("evil.example")).toBe(false)
  })

  test("a shell's tags read the shell's own URL, never the request's Host or undeclared query", async () => {
    const before = probe.tagUrls.length
    await (
      await fetch(`${app.origin}/p/61?utm=tag-canary&color=red`, {
        headers: { host: "evil.example" },
      })
    ).text()
    expect(probe.tagUrls.slice(before)).toEqual(["https://shop.example/p/61?color=red"])
  })

  test("a gate layout refuses before the shell, and its data reaches no PPR response", async () => {
    const refused = await fetch(`${app.origin}/members/3`)
    expect(refused.status).toBe(401)
    expect(await refused.text()).toBe("members only")

    const page = await (
      await fetch(`${app.origin}/members/3`, { headers: { cookie: "s=1" } })
    ).text()
    expect(page).toContain('data-member="no"')
    expect(page.includes('"member":true')).toBe(false)
    expect(page).toContain("nifra-ppr:note")
    const data = firstLine(
      await (
        await fetch(`${app.origin}/members/3`, { headers: { cookie: "s=1", [DATA_HEADER]: "1" } })
      ).text(),
    )
    expect(JSON.stringify(data).includes('member":true')).toBe(false)
  })

  test("a shell loader's notFound() renders the 404 page, and while cached starts no hole", async () => {
    const first = await fetch(`${app.origin}/p/missing`)
    expect(first.status).toBe(404)
    await first.text()
    const builds = probe.shellBuilds
    const started = probe.slowStarted
    const again = await fetch(`${app.origin}/p/missing`)
    expect(again.status).toBe(404)
    await again.text()
    expect(probe.shellBuilds).toBe(builds)
    expect(probe.slowStarted).toBe(started)
  })

  test("a declared variation keys its own shell; other parameters and values share the default", async () => {
    const shellAt = async (query: string) => {
      const before = probe.shellBuilds
      await (await fetch(`${app.origin}/p/20${query}`)).text()
      return probe.shellBuilds - before
    }
    expect(await shellAt("?color=red&utm=1")).toBe(1)
    expect(probe.shellVariations).toEqual({ color: "red" })
    expect(await shellAt("?utm=2&color=red")).toBe(0)
    expect(await shellAt("")).toBe(1)
    expect(probe.shellVariations).toEqual({})
    expect(await shellAt("?color=green")).toBe(0)
    expect(await shellAt("?color=red&color=blue")).toBe(0)
    expect(await shellAt("?color=blue")).toBe(1)
  })

  test("visitors with different cookies, headers, Host and query share one shell holding none of them", async () => {
    const visit = async (headers: Record<string, string>, query: string) =>
      shellOf(await (await fetch(`${app.origin}/p/50${query}`, { headers })).text())
    const first = await visit(
      { cookie: "name=ada; session=cookie-canary-1" },
      "?utm=query-canary-1",
    )
    const second = await visit(
      {
        cookie: "name=grace; session=cookie-canary-2",
        authorization: "Bearer auth-canary-2",
        "x-forwarded-host": "evil.example",
        "accept-language": "fr",
      },
      "?utm=query-canary-2",
    )
    expect(first.length).toBeGreaterThan(0)
    expect(second).toBe(first)
    for (const canary of ["canary", "ada", "grace", "evil.example", "hello "])
      expect(first.includes(canary)).toBe(false)
  })

  test("the canary check passes the fixture's shells, gated ones included", async () => {
    const proxy = {
      fetch: (request: Request) => {
        const url = new URL(request.url)
        return fetch(`${app.origin}${url.pathname}${url.search}`, { headers: request.headers })
      },
    }
    expect(await checkShellCanaries(proxy, ["/p/54", "/members/54"])).toEqual([])
  })

  test("an output schema keeps a hole loader's undeclared keys out of every response", async () => {
    const headers = { cookie: "name=ada" }
    const document = await (await fetch(`${app.origin}/p/51`, { headers })).text()
    const data = await (
      await fetch(`${app.origin}/p/51`, { headers: { ...headers, [DATA_HEADER]: "1" } })
    ).text()
    const whole = await (
      await fetch(`${app.origin}/p/51`, { headers: { ...headers, "user-agent": "Twitterbot/1.0" } })
    ).text()
    expect(document).toContain('"props":{"count":2}')
    for (const body of [document, data, whole]) expect(body.includes("staff-only")).toBe(false)
  })

  test("a draft renders whole from a fresh shell loader call and never fills the shared shell", async () => {
    const cookie = `${await draftCookie()}; name=ada`
    const before = probe.shellBuilds
    const draft = await (await fetch(`${app.origin}/p/52`, { headers: { cookie } })).text()
    expect(draft.includes("__nifraPpr")).toBe(false)
    expect(draft).toContain(
      '"greeting":{"name":"greeting","mode":"dynamic","status":"ready","data":{"name":"ada"}}',
    )
    expect(probe.shellBuilds - before).toBe(1)
    await (await fetch(`${app.origin}/p/52`)).text()
    expect(probe.shellBuilds - before).toBe(2)
  })

  // Anonymous requests: withISR passes any request with a cookie straight through.
  test("withISR stores no response of a PPR route that declares revalidate", async () => {
    const stored: string[] = []
    const entries = new Map<string, CachedResponse>()
    const store: CacheStore = {
      get: async (key) => entries.get(key),
      set: async (key, value) => {
        stored.push(key)
        entries.set(key, value)
      },
      delete: async (key) => {
        entries.delete(key)
      },
    }
    const served = withISR(
      {
        fetch: (request) => {
          const url = new URL(request.url)
          return fetch(`${app.origin}${url.pathname}${url.search}`, { headers: request.headers })
        },
      },
      { store, storeSecret: "ppr-app-test-store-secret-0123456789", revalidate: 60, now: Date.now },
    )
    const page = await served(new Request("https://shop.example/p/53", {}))
    expect(page.headers.get("cache-control")).toBe("private, no-store")
    await page.text()
    const bot = await served(
      new Request("https://shop.example/p/53", {
        headers: { "user-agent": "Twitterbot/1.0" },
      }),
    )
    expect(await bot.text()).toContain('"data":{"name":"guest"}')
    await (
      await served(
        new Request("https://shop.example/p/53", {
          headers: { [DATA_HEADER]: "1" },
        }),
      )
    ).text()
    expect(stored).toEqual([])
  })

  test("the fixture's shells hold enough text for WebKit to paint them early", () => {
    expect(app.warnings.filter((line) => line.includes("characters of text"))).toEqual([])
  })
})

/** A whole NDJSON data response: its first line, with each deferred value put in its place. */
const settledPayload = (text: string): { readonly boundaries?: Record<string, unknown> } => {
  const [head = "null", ...rest] = text.split("\n").filter((line) => line !== "")
  const values = new Map<number, unknown>()
  for (const line of rest) {
    const settled: { readonly i: number; readonly v?: unknown; readonly e?: string } =
      JSON.parse(line)
    values.set(settled.i, settled.e === undefined ? settled.v : { rejected: settled.e })
  }
  return JSON.parse(head, (_key, value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    "__nifra_deferred" in value &&
    typeof value.__nifra_deferred === "number"
      ? values.get(value.__nifra_deferred)
      : value,
  )
}

describe("PPR app: a page that reloads with its holes as hosts", () => {
  /** A reload of a page whose holes on screen are all hosts. */
  const refill = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${app.origin}${path}`, {
      headers: {
        [DATA_HEADER]: "1",
        [HOLE_FILL_HEADER]: path.startsWith("/s/") ? "price,greeting" : "greeting,cart,slow",
        cookie: "name=ada",
        ...headers,
      },
    })

  test("each hole's state carries its fill: server HTML, with props only for an interactive hole", async () => {
    const payload = settledPayload(await (await refill("/p/31")).text())
    expect(payload.boundaries?.greeting).toEqual({
      name: "greeting",
      mode: "dynamic",
      status: "pending",
      ppr: true,
      fill: { v: 1, html: '<p id="greeting">hello <!-- -->ada</p>' },
    })
    // The output schema still applies: the coupon the loader returned reaches no response.
    expect(payload.boundaries?.cart).toMatchObject({
      ppr: true,
      fill: { v: 1, props: { count: 2 } },
    })
    expect(JSON.stringify(payload).includes("staff-only-coupon")).toBe(false)
  })

  test("a shared hole's fill comes from its entry", async () => {
    const before = probe.priceBuilds
    await (await fetch(`${app.origin}/s/45`)).text()
    const payload = settledPayload(await (await refill("/s/45")).text())
    expect(probe.priceBuilds - before).toBe(1)
    expect(payload.boundaries?.price).toEqual({
      name: "price",
      mode: "shared",
      status: "pending",
      ppr: true,
      fill: { v: 1, html: '<p id="price">price <!-- -->450</p>' },
    })
  })

  test("a hole that fails sends the error frame, never content from before", async () => {
    const payload = settledPayload(await (await refill("/p/32?fail")).text())
    expect(payload.boundaries?.slow).toMatchObject({ ppr: true, fill: { v: 1, error: true } })
  })

  test("a kept hole does not load, and a name the route does not declare is refused", async () => {
    const started = probe.slowStarted
    const payload = settledPayload(
      await (await refill("/p/33", { [KEEP_HOLES_HEADER]: "slow, cart" })).text(),
    )
    expect(probe.slowStarted).toBe(started)
    expect(payload.boundaries?.slow).toEqual({
      name: "slow",
      mode: "dynamic",
      status: "pending",
      ppr: true,
      kept: true,
    })
    expect(payload.boundaries?.cart).toMatchObject({ kept: true })
    expect(payload.boundaries?.greeting).toMatchObject({ fill: { v: 1 } })
    const refused = await refill("/p/33", { [KEEP_HOLES_HEADER]: "slow,coupon" })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toBe("Bad Request: the route has no such hole")
  })

  test("only the holes the client names as hosts reload as fills; an unknown name is refused", async () => {
    const payload = settledPayload(
      await (await refill("/p/35", { [HOLE_FILL_HEADER]: "cart" })).text(),
    )
    expect(payload.boundaries?.cart).toMatchObject({ ppr: true, fill: { v: 1 } })
    expect(payload.boundaries?.greeting).toMatchObject({ data: { name: "ada" } })
    expect(payload.boundaries?.greeting).not.toHaveProperty("ppr")
    const refused = await refill("/p/35", { [HOLE_FILL_HEADER]: "cart,coupon" })
    expect(refused.status).toBe(400)
  })

  test("a gate that refuses answers before any hole loads", async () => {
    const started = probe.slowStarted
    const refused = await fetch(`${app.origin}/members/3`, {
      headers: { [DATA_HEADER]: "1", [HOLE_FILL_HEADER]: "note" },
    })
    expect(refused.status).toBe(401)
    expect(await refused.text()).toBe("members only")
    expect(probe.slowStarted).toBe(started)
  })

  test("leaving during a refill aborts its holes on the server", async () => {
    const started = probe.slowStarted
    const client = new AbortController()
    const res = await fetch(`${app.origin}/p/34?slow=60000`, {
      headers: { [DATA_HEADER]: "1", [HOLE_FILL_HEADER]: "slow" },
      signal: client.signal,
    })
    const reader = res.body?.getReader()
    const head = new TextDecoder().decode((await reader?.read())?.value)
    expect(probe.slowStarted).toBe(started + 1)
    expect(firstLine(head).boundaries?.slow).toMatchObject({ ppr: true })
    const aborted = nextSlowAbort()
    client.abort()
    await aborted
  })
})

describe("PPR app: a shared hole", () => {
  /** Hole `name`'s frame: its inert JSON script and its invoker. */
  const frameOf = (html: string, name: string): string => {
    const start = html.indexOf(`<script type="application/json" id="nifra-ppr:${name}">`)
    const invoker = html.indexOf("<script>", start)
    return start === -1 ? "" : html.slice(start, html.indexOf("</script>", invoker) + 9)
  }
  const frameHtml = (html: string, name: string): unknown => {
    const frame = frameOf(html, name)
    return JSON.parse(frame.slice(frame.indexOf(">") + 1, frame.indexOf("</script>"))).html
  }

  test("is built once, its loader checked, and every visitor gets the same frame bytes", async () => {
    const before = probe.priceBuilds
    const visit = async (name: string) =>
      (await fetch(`${app.origin}/s/41`, { headers: { cookie: `name=${name}` } })).text()
    const ada = await visit("ada")
    const grace = await visit("grace")
    expect(probe.priceBuilds - before).toBe(1)
    expect(frameHtml(ada, "price")).toBe('<p id="price">price <!-- -->410</p>')
    expect(frameOf(grace, "price")).toBe(frameOf(ada, "price"))
    expect(frameHtml(ada, "greeting")).toBe('<p id="greeting">hello <!-- -->ada</p>')
    expect(frameHtml(grace, "greeting")).toBe('<p id="greeting">hello <!-- -->grace</p>')
    expect(app.warnings.some((warning) => warning.includes('shared hole "price"'))).toBe(false)
  })

  test("a soft navigation's data request carries the held frame's data, ready", async () => {
    await (await fetch(`${app.origin}/s/43`)).text()
    const payload = firstLine(
      await (await fetch(`${app.origin}/s/43`, { headers: { [DATA_HEADER]: "1" } })).text(),
    )
    expect(payload.boundaries?.price).toEqual({
      name: "price",
      mode: "shared",
      status: "ready",
      data: { amount: 430 },
    })
  })

  test("the canary check scans the shared frame and passes it", async () => {
    const proxy = {
      fetch: (request: Request) => {
        const url = new URL(request.url)
        return fetch(`${app.origin}${url.pathname}${url.search}`, { headers: request.headers })
      },
    }
    expect(await checkShellCanaries(proxy, ["/s/44"])).toEqual([])
  })
})

describe("PPR app behind compression()", () => {
  test("the gzipped stream delivers the shell and early holes while a slow hole runs", async () => {
    const zipped = await startPprApp(undefined, { compress: true })
    const leaving = new AbortController()
    try {
      const res = await fetch(`${zipped.origin}/p/57?slow=5000`, {
        headers: { cookie: "name=ada", "accept-encoding": "gzip" },
        signal: leaving.signal,
      })
      expect(res.headers.get("content-encoding")).toBe("gzip")
      if (res.body === null) throw new Error("no body")
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ""
      while (!text.includes('__nifraPpr("greeting")')) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      expect(text).toContain('<h1 id="title">Product 57</h1>')
      expect(text).toContain('id="nifra-ppr:greeting"')
      expect(text.includes('id="nifra-ppr:slow"')).toBe(false)
      const aborted = nextSlowAbort()
      leaving.abort()
      await aborted
    } finally {
      await zipped.stop()
    }
  })
})

describe("PPR fixture app: what the browser checks lean on", () => {
  test("a held cart hole streams its frame once released", async () => {
    const res = await fetch(`${app.origin}/p/61?hold=1`)
    // Every hole loader starts before the response does, so the hold is already waiting.
    expect(releaseHeld()).toBe(1)
    expect(await res.text()).toContain('"props":{"count":2}')
  })

  test("client assets are served by plain name only, and an unrelated route answers late", async () => {
    const page = await (await fetch(`${app.origin}/p/62`)).text()
    const entry = /<link rel="modulepreload" href="(\/assets\/[A-Za-z0-9._-]+\.js)">/.exec(
      page,
    )?.[1]
    if (entry === undefined) throw new Error("the shell names no client entry")
    const script = await fetch(`${app.origin}${entry}`)
    expect(script.status).toBe(200)
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect((await fetch(`${app.origin}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${app.origin}/assets/a%20b.js`)).status).toBe(400)
    expect(await (await fetch(`${app.origin}/__unrelated`)).text()).toBe("unrelated ok")
  })

  test("the probe routes a browser check reads from another process answer with this one's counters", async () => {
    const counters = await (await fetch(`${app.origin}/__probe`)).json()
    expect(counters).toMatchObject({ slowStarted: probe.slowStarted, cancels: probe.cancels })
    expect(counters.timeOrigin).toBe(performance.timeOrigin)
    expect(await (await fetch(`${app.origin}/__release`, { method: "POST" })).json()).toBe(0)
  })
})

describe("PPR app with shellAfterRequests: 2", () => {
  test("in a full store a key's first document streams whole with its holes, and its second builds the shell", async () => {
    const later = await startPprApp(undefined, {
      pprOptions: { shellAfterRequests: 2, shellEntriesPerRoute: 1 },
    })
    try {
      const headers = { cookie: "name=ada" }
      // With room, a key builds at once; this shell fills the route.
      await (await fetch(`${later.origin}/p/40`, { headers })).text()
      const [builds, holes] = [probe.shellBuilds, probe.slowStarted]
      const first = await fetch(`${later.origin}/p/41?slow=1`, { headers })
      const html = await first.text()
      expect(first.status).toBe(200)
      expect(first.headers.get("cache-control")).toBe("private, no-store")
      expect(html).not.toContain('id="nifra-ppr-req"')
      expect(html).toContain("Product 41")
      expect(html).toContain("ada")
      const second = await (await fetch(`${later.origin}/p/41?slow=1`, { headers })).text()
      expect(second).toContain('id="nifra-ppr-req"')
      expect(shellOf(second)).toContain("Product 41")
      expect(shellOf(second)).not.toContain("ada")
      await (await fetch(`${later.origin}/p/41?slow=1`, { headers })).text()
      // The first request ran the shell loader for its own page, the second built the shell, the
      // third reused it; each ran its holes once.
      expect(probe.shellBuilds - builds).toBe(2)
      expect(probe.slowStarted - holes).toBe(3)
      // A soft navigation to a key with no shell reads the shell loader's output directly.
      const data = await fetch(`${later.origin}/p/42?slow=1`, {
        headers: { ...headers, [DATA_HEADER]: "1" },
      })
      expect(firstLine(await data.text())).toMatchObject({ data: { title: "Product 42" } })
      expect(probe.shellBuilds - builds).toBe(3)
    } finally {
      await later.stop()
    }
  })
})

describe("PPR app configuration", () => {
  test("a per-request nonce is refused at startup, since every shell would be unique", () => {
    const manifest: Manifest = {
      routes: [],
      layouts: {},
      notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
    }
    expect(() =>
      createWebApp({
        adapter: {
          renderToStream: () => new ReadableStream(),
          hydrationHead: () => "",
          renderFragment: () => "",
        },
        manifest,
        clientEntry: "/c.js",
        nonce: () => "n",
        experimental: { ppr: partialPrerendering({ shellChecks: "unchecked-development" }) },
      }),
    ).toThrow("experimental.ppr needs `csp: createCspPolicy(...)`, not `nonce`")
  })

  test("an origin with a path, a query or another scheme is refused at startup", () => {
    const start = (origin: string) =>
      partialPrerendering({ shellChecks: "unchecked-development", origin })
    for (const origin of [
      "https://shop.example/",
      "https://shop.example/shop",
      "https://shop.example?x=1",
      "ftp://shop.example",
      "shop.example",
    ]) {
      expect(() => start(origin)).toThrow("experimental.ppr.origin must be an http(s) origin")
    }
    expect(() => start("http://127.0.0.1:3000")).not.toThrow()
  })

  test("a PPR route needs 1 to maxHolesPerRoute holes, each with a loader and a timeout up to the cap", async () => {
    const adapter: RenderAdapter = {
      renderToStream: () => new ReadableStream(),
      renderToString: () => "<p>page</p>",
      hydrationHead: () => "",
      renderFragment: () => "",
    }
    const hole = (name: string, timeout?: number) => {
      const registration: {
        name: string
        mode: "dynamic"
        render: () => string
        load: () => number
        timeout?: number
      } = { name, mode: "dynamic", render: () => "", load: () => 1 }
      if (timeout !== undefined) registration.timeout = timeout
      return registration
    }
    /** The error a GET of the route logs; core answers a bare 500 after logging it to stderr. */
    const failureOf = async (
      boundaries: readonly BoundaryRegistration[],
      layout?: Record<string, unknown>,
    ) => {
      const manifest: Manifest = {
        routes: [
          {
            id: "p",
            pattern: "/p",
            layoutIds: layout === undefined ? [] : ["_layout"],
            file: "p.tsx",
            load: async () => ({ default: "page", shellLoader: () => ({}), boundaries }),
          },
        ],
        layouts:
          layout === undefined
            ? {}
            : { _layout: { file: "_layout.tsx", load: async () => ({ default: "l", ...layout }) } },
        notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
      }
      const app = createWebApp({
        adapter,
        manifest,
        clientEntry: "/c.js",
        experimental: {
          ppr: partialPrerendering({
            shellChecks: "unchecked-development",
            options: { maxHolesPerRoute: 2 },
          }),
        },
      })
      const write = process.stderr.write
      let logged = ""
      process.stderr.write = (chunk: string | Uint8Array) => {
        logged += String(chunk)
        return true
      }
      try {
        const response = await app.fetch(new Request("http://x/p"))
        await response.text()
        return response.status === 500 ? logged : `status ${response.status}`
      } finally {
        process.stderr.write = write
      }
    }
    expect(await failureOf([])).toContain("0 dynamic or shared boundaries; it needs 1 to 2")
    expect(await failureOf([hole("a"), hole("b"), hole("c")])).toContain(
      "3 dynamic or shared boundaries; it needs 1 to 2",
    )
    for (const timeout of [0, 1.5, 30_001, Number.NaN]) {
      expect(await failureOf([hole("a", timeout)])).toContain(
        "it must be a whole number of milliseconds from 1 to 30000",
      )
    }
    expect(await failureOf([{ name: "a", mode: "dynamic", render: () => "" }])).toContain(
      'boundary \\"a\\" of route \\"p\\" has no boundaryLoaders entry',
    )
    // An intercepting boundary is no hole: it is not counted against the limits, and it is not refused.
    const modal = { name: "m", mode: { intercept: "/x" }, render: () => "" } as const
    expect(await failureOf([modal])).toContain("0 dynamic or shared boundaries; it needs 1 to 2")
    expect(await failureOf([hole("a"), hole("b"), modal])).toContain('hole \\"a\\" has no host')
    expect(await failureOf([hole("a")], { loader: () => ({}) })).toContain(
      'its layout \\"_layout\\" has a loader that is not a gate',
    )
    // Past the rules, the next failure is the stub rendering no host for the hole.
    expect(await failureOf([hole("a", 30_000), hole("b", 1)])).toContain('hole \\"a\\" has no host')
  })
})
