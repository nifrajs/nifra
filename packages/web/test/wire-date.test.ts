import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { DEFERRED_RUNTIME, MAP_DEFERRED_SOURCE, parseNdjsonData } from "../src/deferred.ts"
import { buildManifest, createWebApp, type RenderAdapter, type RouteModule } from "../src/index.ts"
import { guardValue, OutputGuardError, outputGuard } from "../src/internal/output-guard.ts"
import { DATE_TAG, parsePageData, REVIVE_DATES_SOURCE } from "../src/internal/revive-dates.ts"
import { generateServerFnStub } from "../src/internal/server-boundary.ts"
import { WireDate } from "../src/internal/wire-date.ts"
import { DATA_HEADER } from "../src/router.ts"

// `t.date()` page data: a Date on the server render, `{ "__nifra_date": iso }` on the wire, and a Date
// again wherever the browser parses page data.

const AT = "2026-10-07T12:30:00.000Z"
const TAG = `{"${DATE_TAG}":"${AT}"}`

const guard = (schema: unknown, value: unknown): unknown =>
  guardValue(
    {
      label: 'the loader of "page.tsx"',
      guard: outputGuard(schema, '"page.backend.ts"', "loaderOutput"),
      missing: "export const loaderOutput",
    },
    value,
  )

/** The value at `path` inside `value`, or `undefined` once a step is not an object. */
const at = (value: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce<unknown>(
    (v, key) => (typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined),
    value,
  )

const isoOf = (value: unknown): string | undefined =>
  value instanceof Date ? value.toISOString() : undefined

describe("the output guard", () => {
  test("a Date or an ISO string becomes a WireDate, at any depth", () => {
    const schema = t.object({
      at: t.date(),
      day: t.date(),
      events: t.array(t.object({ when: t.date() })),
    })
    const out = guard(schema, { at: new Date(AT), day: "2026-10-07", events: [{ when: AT }] })
    expect(at(out, "at")).toBeInstanceOf(WireDate)
    expect(isoOf(at(out, "at"))).toBe(AT)
    expect(at(out, "day")).toBeInstanceOf(WireDate)
    expect(at(out, "events", 0, "when")).toBeInstanceOf(WireDate)
    expect(JSON.stringify(at(out, "at"))).toBe(TAG)
  })

  test("a nullable date keeps null and turns a Date into a WireDate", () => {
    const schema = t.object({ at: t.union([t.date(), t.null()]) })
    expect(guard(schema, { at: null })).toEqual({ at: null })
    expect(at(guard(schema, { at: new Date(AT) }), "at")).toBeInstanceOf(WireDate)
  })

  test("a value that is not a date fails by path, never by value", () => {
    const schema = t.object({ at: t.date() })
    for (const value of ["next tuesday", new Date(Number.NaN), 17]) {
      let error: unknown
      try {
        guard(schema, { at: value })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(OutputGuardError)
      const message = error instanceof Error ? error.message : ""
      expect(message).toContain("/at")
      expect(message).not.toContain("tuesday")
    }
  })

  test("t.json passes any JSON through whole and refuses what is not JSON", () => {
    const schema = t.object({ payload: t.json() })
    const payload = { tool: "search", args: [{ q: "x", deep: { n: 1 } }] }
    expect(guard(schema, { payload })).toEqual({ payload })
    expect(() => guard(schema, { payload: { at: new Map() } })).toThrow(OutputGuardError)
  })
})

describe("the browser side", () => {
  const MIXED = `{"at":${TAG},"list":[${TAG},"${AT}"],"other":{"${DATE_TAG}":"${AT}","extra":1},"__proto__":${TAG}}`

  test("parsePageData rebuilds tags and leaves everything else alone", () => {
    const out = parsePageData(MIXED)
    expect(at(out, "at")).toBeInstanceOf(Date)
    expect(at(out, "list", 0)).toBeInstanceOf(Date)
    // A plain string that reads like a date is a string: only a tag is a date.
    expect(at(out, "list", 1)).toBe(AT)
    expect(at(out, "other")).toEqual({ [DATE_TAG]: AT, extra: 1 })
    // A `__proto__` key stays an own property; it never becomes the prototype.
    expect(typeof out === "object" && out !== null && Object.hasOwn(out, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(parsePageData('{"a":{"b":1}}')).toEqual({ a: { b: 1 } })
  })

  test("the generated reviver agrees with parsePageData", () => {
    const generated: (value: unknown) => unknown = new Function(
      `${REVIVE_DATES_SOURCE}; return __nifraDates`,
    )()
    const out = generated(JSON.parse(MIXED))
    expect(out).toEqual(parsePageData(MIXED))
    expect(at(out, "list", 0)).toBeInstanceOf(Date)
    expect(typeof out === "object" && out !== null && Object.hasOwn(out, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  test("the literal copies of the reviver stay in step with the tag", () => {
    const flat = (source: string) => source.replaceAll(/\s+/g, " ")
    expect(flat(DEFERRED_RUNTIME)).toContain(flat(REVIVE_DATES_SOURCE))
    expect(REVIVE_DATES_SOURCE).toContain(`"${DATE_TAG}"`)
    expect(MAP_DEFERRED_SOURCE).toContain(`d.${DATE_TAG}`)
  })

  test("hydration (mapDeferred) rebuilds tagged dates", () => {
    const mapDeferred: (value: unknown) => unknown = new Function(
      "window",
      `${MAP_DEFERRED_SOURCE}; return mapDeferred`,
    )({})
    const out = mapDeferred(JSON.parse(`{"at":${TAG},"nested":[{"at":${TAG}}]}`))
    expect(at(out, "at")).toBeInstanceOf(Date)
    expect(isoOf(at(out, "nested", 0, "at"))).toBe(AT)
  })

  test("a streamed deferred value settles with its dates rebuilt", async () => {
    const window: Record<string, (...args: unknown[]) => unknown> = {}
    new Function("window", DEFERRED_RUNTIME)(window)
    const settled = window.__nifraDeferred?.(1)
    window.__nifraResolve?.(1, JSON.parse(`{"at":${TAG}}`))
    expect(at(await settled, "at")).toBeInstanceOf(Date)
  })

  test("a navigation stream rebuilds dates in the first line and in resolved values", async () => {
    const lines = [`{"at":${TAG},"later":{"__nifra_deferred":1}}`, `{"i":1,"v":{"at":${TAG}}}`]
    const data = await parseNdjsonData(new Blob([`${lines.join("\n")}\n`]).stream())
    expect(at(data, "at")).toBeInstanceOf(Date)
    expect(at(await at(data, "later", "promise"), "at")).toBeInstanceOf(Date)
  })

  test("a server function's stub rebuilds dates in its result", async () => {
    const stub = generateServerFnStub("export const when = serverFn(async () => 1)\n", "clock")
    const fetch = async () =>
      new Response(`{"at":${TAG}}`, { headers: { "content-type": "application/json" } })
    const exports: { when: () => Promise<unknown> } = new Function(
      "fetch",
      `${stub.replaceAll(/^export const (\w+) =/gm, "const $1 =")}\nreturn { when }`,
    )(fetch)
    expect(at(await exports.when(), "at")).toBeInstanceOf(Date)
  })
})

describe("a page end to end", () => {
  let rendered: unknown
  const adapter: RenderAdapter = {
    renderToStream: (_chain, props) => {
      rendered = props.data
      return new Blob(["<main></main>"]).stream()
    },
    hydrationHead: () => "",
  }
  const backendHalf: Pick<RouteModule, "loader" | "loaderOutput"> = {
    loader: () => ({ at: new Date(AT), title: "launch" }),
    loaderOutput: t.object({ at: t.date(), title: t.string() }),
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a backend half has no `default` export, and the importer type names the merged module
  const backend = backendHalf as RouteModule
  const app = createWebApp({
    adapter,
    clientEntry: "/c.js",
    manifest: buildManifest(
      ["_error.tsx", "page.tsx", "page.backend.ts"],
      (file) => async () => (file === "page.backend.ts" ? backend : { default: file }),
    ),
  })

  test("the server render gets a Date and the document hands the browser a tag", async () => {
    const page = await (await app.fetch(new Request("http://x/page"))).text()
    expect(at(rendered, "at")).toBeInstanceOf(Date)
    expect(page).toContain(TAG)
  })

  test("a navigation's data request carries the tag, which the browser parse rebuilds", async () => {
    const res = await app.fetch(new Request("http://x/page", { headers: { [DATA_HEADER]: "1" } }))
    const text = await res.text()
    expect(text).toContain(TAG)
    expect(at(parsePageData(text), "at")).toBeInstanceOf(Date)
  })
})
