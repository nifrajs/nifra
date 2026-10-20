import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
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

  test("the fixture's shells hold enough text for WebKit to paint them early", () => {
    expect(app.warnings.filter((line) => line.includes("characters of text"))).toEqual([])
  })
})

describe("PPR app configuration", () => {
  test("an origin with a path, a query or another scheme is refused at startup", () => {
    const adapter: RenderAdapter = {
      renderToStream: () => new ReadableStream(),
      hydrationHead: () => "",
      renderFragment: () => "",
    }
    const manifest: Manifest = {
      routes: [],
      layouts: {},
      notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
    }
    const start = (origin: string) =>
      createWebApp({
        adapter,
        manifest,
        clientEntry: "/c.js",
        experimental: { ppr: { shellChecks: "unchecked-development", origin } },
      })
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
})
