import { expect, test } from "bun:test"
import { hashSource } from "../src/csp.ts"
import { encodeHoleFrame } from "../src/internal/ppr/frames.ts"
import { resolvePprOptions } from "../src/internal/ppr/options.ts"
import { PPR_RUNTIME, pprScriptHashes } from "../src/internal/ppr/runtime.ts"
import { createPprServer, type PprRequest, type SharedHole } from "../src/internal/ppr/server.ts"
import { type StoredEntry, sharedShellStore } from "../src/internal/ppr/shell-store.ts"
import { parsePageData } from "../src/internal/revive-dates.ts"
import { wireDate } from "../src/internal/wire-date.ts"
import { MemoryCacheStore } from "../src/isr.ts"

const ISO = "2026-01-01T00:00:00.000Z"
const sample = () => ({
  nested: [{ at: wireDate(Date.parse(ISO)), list: [wireDate(Date.parse(ISO))] }],
  text: ISO,
  extra: { __nifra_date: ISO, label: "user data" },
  numeric: { __nifra_date: 123 },
  invalid: { __nifra_date: "not a date" },
  ...JSON.parse(
    '{"__proto__":{"__nifra_date":"2026-01-01T00:00:00.000Z"},"constructor":{"prototype":{"safe":true}}}',
  ),
})

const check = (value: ReturnType<typeof sample>) => {
  expect(value.nested[0].at).toBeInstanceOf(Date)
  expect(value.nested[0].at.toISOString()).toBe(ISO)
  expect(value.nested[0].list[0].toISOString()).toBe(ISO)
  expect(value.text).toBe(ISO)
  expect(value.extra).toEqual({ __nifra_date: ISO, label: "user data" })
  expect(value.numeric).toEqual({ __nifra_date: 123 })
  expect(value.invalid).toBeInstanceOf(Date)
  expect(Number.isNaN(Date.prototype.getTime.call(value.invalid))).toBe(true)
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  expect(Object.hasOwn(value, "__proto__")).toBe(true)
  expect(Reflect.get(value, "__proto__").toISOString()).toBe(ISO)
  expect(Reflect.get(Object.prototype, "safe")).toBeUndefined()
}

test("streamed PPR interactive props revive dates without changing user objects or prototypes", async () => {
  const attributes = new Map<string, string>()
  const host = {
    innerHTML: "",
    hasAttribute: (key: string) => attributes.has(key),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  }
  const html = encodeHoleFrame("price", { html: "<p>price</p>", props: sample() }, 16384)
  const frame = {
    textContent: html.slice(html.indexOf(">") + 1, html.indexOf("</script>")),
    remove() {},
  }
  type Fill = { props: ReturnType<typeof sample> }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The evaluated runtime installs this exact global API before use.
  const window = {} as {
    __nifraPpr: {
      (name: string): void
      get(name: string): Fill
      subscribe(name: string, callback: (fill: Fill) => void): void
    }
  }
  new Function("window", "document", PPR_RUNTIME)(window, {
    getElementById: () => frame,
    querySelector: () => host,
  })
  let notified = false
  window.__nifraPpr.subscribe("price", (fill) => {
    check(fill.props)
    notified = true
  })
  window.__nifraPpr("price")
  check(window.__nifraPpr.get("price").props)
  expect(notified).toBe(true)
  expect(host.innerHTML).toBe("<p>price</p>")
  expect(await pprScriptHashes(["price"])).toContain(await hashSource(PPR_RUNTIME))
})

const entry = (data: unknown): StoredEntry => ({
  routeId: "product",
  html: "<p>cached</p>",
  tokenAt: 0,
  data,
  builtAt: Date.now(),
  tags: [],
  notFound: false,
})
const SECRET = "a shared shell signing secret of 32+ chars"

test("signed PPR cache revives server dates with browser tag semantics and prototype safety", async () => {
  const cache = new MemoryCacheStore()
  const writer = sharedShellStore(cache, SECRET, "d1")
  await writer.set("dates", entry(sample()), 60, undefined)
  const reader = sharedShellStore(cache, SECRET, "d1")
  const hit = await reader.get("dates")
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: This fixture was written above; check validates each revived field.
  check(hit?.data as ReturnType<typeof sample>)
})

test("a second PPR server renders cached shared-hole dates and preserves tags on another response", async () => {
  const cache = new MemoryCacheStore()
  const writes: Promise<unknown>[] = []
  let loads = 0
  const hole: SharedHole = {
    name: "price",
    mode: "shared",
    revalidate: 60,
    fallback: "loading",
    load: () => {
      loads++
      return { nested: [{ at: wireDate(Date.parse(ISO)) }] }
    },
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: This render consumes the nested Date returned by this hole's loader.
    render: (data: never) => (data as { nested: [{ at: Date }] }).nested[0].at.toISOString(),
  }
  const request = new Request("https://shop.test/product")
  const req: PprRequest = {
    routeId: "product",
    path: "/product",
    locale: undefined,
    variations: {},
    request,
    holes: [hole],
    holeContext: { request, params: {}, api: undefined, env: undefined, draft: false, search: {} },
    shellContext: { phase: "shell", params: {}, locale: undefined, variations: {}, api: undefined },
    loadShell: async () => ({}),
    renderShellDocument: async () => "",
    revalidate: undefined,
    tags: () => [],
    holeTags: () => [],
    waitUntil: (promise) => {
      writes.push(promise)
    },
  }
  const server = () =>
    createPprServer({
      options: resolvePprOptions(),
      deployment: "d1",
      cancelUrl: "/cancel",
      adapter: {
        renderToStream: () => new ReadableStream(),
        hydrationHead: () => "",
        renderFragment: (ui) => String(ui()),
      },
      shared: sharedShellStore(cache, SECRET, "d1"),
      shellChecks: {
        v: 1,
        deployment: "d1",
        routes: { product: "h1" },
        sharedHoles: { product: ["price"] },
      },
    })
  await server().holeStates(req, "settled", new AbortController().signal)
  await Promise.all(writes)
  const states = await server().holeStates(req, "settled", new AbortController().signal)
  expect(loads).toBe(1)
  const price = states.price
  if (price === undefined) throw new Error("expected the settled price hole")
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The settled state is the value from this test's shared-hole loader.
  const data = price.data as { nested: [{ at: Date }] }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: HoleRegistration erases the render input; this is its own settled data.
  expect(hole.render(data as never)).toBe(ISO)
  const json = JSON.stringify(data)
  expect(JSON.parse(json).nested[0].at).toEqual({ __nifra_date: ISO })
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The JSON was just serialized from this loader's nested Date shape.
  expect((parsePageData(json) as typeof data).nested[0].at.toISOString()).toBe(ISO)
  await sharedShellStore(cache, SECRET, "d1").set("again", entry(data), 60, undefined)
  const again = await sharedShellStore(cache, SECRET, "d1").get("again")
  expect(JSON.stringify(again?.data)).toBe(json)
})
