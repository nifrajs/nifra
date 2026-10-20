import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { partialPrerendering } from "../src/ppr.ts"
import { DATA_HEADER, PREFETCH_HEADER } from "../src/router.ts"
import { nextSlowAbort, probe } from "./fixtures/ppr/app/lib/probe.ts"
import { type PprApp, startPprApp } from "./fixtures/ppr/app/server.ts"

let app: PprApp
beforeAll(async () => {
  app = await startPprApp()
})
afterAll(async () => {
  await app.stop()
})

const firstLine = (text: string): { readonly boundaries?: Record<string, unknown> } =>
  JSON.parse(text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n")))

describe("PPR app: requests that are not a streamed document", () => {
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

  test("the fixture's shells hold enough text for WebKit to paint them early", () => {
    expect(app.warnings.filter((line) => line.includes("characters of text"))).toEqual([])
  })
})

describe("PPR app configuration", () => {
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

  test("a PPR route needs 1 to maxHolesPerRoute holes, each timeout a whole number up to the cap", async () => {
    const adapter: RenderAdapter = {
      renderToStream: () => new ReadableStream(),
      renderToString: () => "<p>page</p>",
      hydrationHead: () => "",
      renderFragment: () => "",
    }
    const hole = (name: string, timeout?: number) => ({
      name,
      mode: "dynamic" as const,
      render: () => "",
      load: () => 1,
      ...(timeout === undefined ? {} : { timeout }),
    })
    /** The error a GET of the route logs; core answers a bare 500 after logging it to stderr. */
    const failureOf = async (boundaries: readonly ReturnType<typeof hole>[]) => {
      const manifest: Manifest = {
        routes: [
          {
            id: "p",
            pattern: "/p",
            layoutIds: [],
            file: "p.tsx",
            load: async () => ({ default: "page", shellLoader: () => ({}), boundaries }),
          },
        ],
        layouts: {},
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
    expect(await failureOf([])).toContain("0 dynamic boundaries; it needs 1 to 2")
    expect(await failureOf([hole("a"), hole("b"), hole("c")])).toContain(
      "3 dynamic boundaries; it needs 1 to 2",
    )
    for (const timeout of [0, 1.5, 30_001, Number.NaN]) {
      expect(await failureOf([hole("a", timeout)])).toContain(
        "it must be a whole number of milliseconds from 1 to 30000",
      )
    }
    // Past the rules, the next failure is the stub rendering no host for the hole.
    expect(await failureOf([hole("a", 30_000), hole("b", 1)])).toContain('hole \\"a\\" has no host')
  })
})
