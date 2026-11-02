import { afterEach, expect, test } from "bun:test"
import { loadCart, loadGreeting, loadRecs, readProduct } from "./backend/catalog.ts"
import * as shared from "./shared/catalog.ts"

const upstream = process.env.PPR_UPSTREAM
const partsUpstream = process.env.PPR_PARTS_UPSTREAM
afterEach(() => {
  if (upstream === undefined) delete process.env.PPR_UPSTREAM
  else process.env.PPR_UPSTREAM = upstream
  if (partsUpstream === undefined) delete process.env.PPR_PARTS_UPSTREAM
  else process.env.PPR_PARTS_UPSTREAM = partsUpstream
})

test("the shared catalog exposes only browser-safe wire schemas", async () => {
  expect(Object.keys(shared).sort()).toEqual([
    "cartSchema",
    "greetingSchema",
    "productSchema",
    "recsSchema",
    "relatedSchema",
  ])
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/shared/catalog.ts`],
    target: "browser",
    // No outdir: inspect in-memory artifacts only.
  })
  expect(result.success).toBe(true)
  const code = await result.outputs[0]?.text()
  expect(code).toContain("productSchema")
  expect(code).not.toMatch(/PPR_UPSTREAM|PPR_PARTS_UPSTREAM|readProduct|loadGreeting|headers\.get/)
})

test("server catalog preserves inline products, cookies and zero-scale parts", async () => {
  delete process.env.PPR_UPSTREAM
  delete process.env.PPR_PARTS_UPSTREAM
  expect(await readProduct("7")).toEqual({
    id: "7",
    name: "Product 7",
    price: "$42.00",
    description: "",
    specs: [],
    related: [],
  })
  const request = new Request("https://shop.example/ppr/7?scale=0", {
    headers: { cookie: "other=1; user=ada" },
  })
  expect(await loadGreeting(request)).toEqual({ name: "ada" })
  expect(await loadGreeting(new Request(request.url))).toEqual({ name: "guest" })
  expect(await loadCart(request)).toEqual({ count: 2 })
  expect(await loadRecs(request)).toEqual({
    items: Array.from({ length: 8 }, (_, i) => `Recommended tea ${i}`),
  })
})

test("server catalog preserves encoded product ids and upstream part durations", async () => {
  const paths: string[] = []
  const product = { name: "Remote tea", price: "$12", description: "Tea", specs: [], related: [] }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      paths.push(path)
      return Response.json(path.startsWith("/product/") ? product : { ok: true })
    },
  })
  try {
    process.env.PPR_UPSTREAM = server.url.origin
    process.env.PPR_PARTS_UPSTREAM = "1"
    expect(await readProduct("tea/one")).toEqual({ id: "tea/one", ...product })
    const request = new Request("https://shop.example/ppr/7?scale=0.5", {
      headers: { cookie: "user=ada" },
    })
    expect(
      await Promise.all([loadGreeting(request), loadCart(request), loadRecs(request)]),
    ).toEqual([
      { name: "ada" },
      { count: 2 },
      { items: Array.from({ length: 8 }, (_, i) => `Recommended tea ${i}`) },
    ])
    expect(paths.sort()).toEqual(["/part/20", "/part/200", "/part/75", "/product/tea%2Fone"])
  } finally {
    await server.stop(true)
  }
})

test("all framework benchmark backends resolve the separated catalog imports", async () => {
  delete process.env.PPR_UPSTREAM
  delete process.env.PPR_PARTS_UPSTREAM
  for (const framework of ["react", "preact", "solid", "svelte", "vue"]) {
    const blocking = await import(`./${framework}/routes/blocking/[id].backend.ts`)
    const deferred = await import(`./${framework}/routes/defer/[id].backend.ts`)
    const ppr = await import(`./${framework}/routes/ppr/[id].backend.ts`)
    const ctx = { params: { id: "7" }, request: new Request("https://shop.example/7?scale=0") }
    expect((await blocking.loader(ctx)).product.id).toBe("7")
    expect((await deferred.loader(ctx)).product.id).toBe("7")
    expect((await ppr.shellLoader(ctx)).product.id).toBe("7")
  }
  const sharedHole = await import("./react/routes/ppr-shared/[id].backend.ts")
  expect(
    await sharedHole.boundaryLoaders.related.load({
      phase: "shell",
      params: { id: "7" },
      locale: undefined,
      variations: {},
      signal: new AbortController().signal,
      api: undefined,
    }),
  ).toEqual({ items: [] })
})
