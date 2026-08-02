import { describe, expect, test } from "bun:test"
import { type RenderAssemblyCache, renderPageResult } from "../src/index.ts"

// A minimal sync adapter: the assembly cache is about the DOCUMENT around the app markup, so the
// app markup itself can be trivial.
const adapter = {
  hydrationHead: () => `<style data-adapter>x</style>`,
  renderToStream: () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
  renderToString: (_chain: readonly unknown[], props: { data: unknown }) =>
    `<main>${JSON.stringify(props.data)}</main>`,
  // biome-ignore lint/suspicious/noExplicitAny: structural test double
} as any

const baseInput = (data: unknown) => ({
  adapter,
  chain: [() => null],
  data,
  clientEntry: "/client.js",
  routeId: "index",
  title: "cache-test",
  styles: ["/a.css"],
  preload: ["/chunk.js"],
  islandScripts: ["/island.js"],
})

async function html(page: ReturnType<typeof renderPageResult>): Promise<string> {
  return (await page).toResponse().text()
}

describe("renderPageResult assembly cache", () => {
  test("cached render is byte-identical to uncached, across different per-request data", async () => {
    const slot: RenderAssemblyCache = {}
    const first = await html(renderPageResult({ ...baseInput({ n: 1 }), assemblyCache: slot }))
    expect(first).toBe(await html(renderPageResult(baseInput({ n: 1 }))))
    expect(slot.shellPre).toBeDefined() // the slot was filled by the first render

    // Second render reuses the filled slot; per-request data still lands fresh in markup + data global.
    const second = await html(renderPageResult({ ...baseInput({ n: 2 }), assemblyCache: slot }))
    expect(second).toBe(await html(renderPageResult(baseInput({ n: 2 }))))
    expect(second).toContain('{"n":2}')
    expect(second).not.toContain('{"n":1}')
  })

  test("a per-request nonce bypasses the cache (nonce'd bytes never persist in the slot)", async () => {
    const slot: RenderAssemblyCache = {}
    const nonced = await html(
      renderPageResult({ ...baseInput({ n: 1 }), assemblyCache: slot, nonce: "abc" }),
    )
    expect(nonced).toContain('nonce="abc"')
    expect(slot.shellPre).toBeUndefined() // slot untouched - nothing nonce-specific was cached
    const plain = await html(renderPageResult({ ...baseInput({ n: 1 }), assemblyCache: slot }))
    expect(plain).not.toContain("abc")
  })

  test("non-hydrated pages cache too, and stay script-free", async () => {
    const slot: RenderAssemblyCache = {}
    const input = { ...baseInput({ n: 3 }), hydrate: false as const }
    const first = await html(renderPageResult({ ...input, assemblyCache: slot }))
    const second = await html(renderPageResult({ ...input, assemblyCache: slot }))
    expect(second).toBe(first)
    expect(first).toBe(await html(renderPageResult(input)))
    expect(first).not.toContain("/client.js")
    expect(first).toContain('src="/island.js"') // islands still load on a static page
  })
})
