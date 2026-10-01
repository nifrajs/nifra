import { expect, test } from "bun:test"
import {
  createCspPolicy,
  createNonceResolver,
  createWebApp,
  defer,
  type Manifest,
  MemoryCacheStore,
  nifraScriptHashes,
  type RenderAdapter,
  type RouteModule,
  renderPage,
  unsafeInlineScript,
  withISR,
} from "../src/index.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

// An adapter with a constant inline hydration script, like Solid's `_$HY` bootstrap.
const adapter: RenderAdapter = {
  renderToStream: (_chain, props) => streamOf(`<p>${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "<script>globalThis.boot = 1</script>",
}

const manifestOf = (modules: Record<string, () => RouteModule>): Manifest => ({
  routes: Object.entries(modules).map(([path, mod]) => ({
    id: path === "/" ? "index" : path.slice(1),
    pattern: path,
    layoutIds: [],
    file: `${path}.tsx`,
    load: async () => mod(),
  })),
  layouts: {},
})

const header = ({ sources }: { readonly sources: string }) =>
  `default-src 'self'; script-src 'self' ${sources}`

async function sha256Source(body: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  )
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`
}

/** Every inline script the browser would execute, as `{ attrs, body }`. */
const executableInlineScripts = (html: string) =>
  [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .map((m) => ({ attrs: m[1] ?? "", body: m[2] ?? "" }))
    .filter((s) => !/\bsrc=/.test(s.attrs) && !s.attrs.includes('type="application/json"'))

test("a plain page under a CSP policy is nonce-free, cacheable, and every inline script is hashed", async () => {
  const app = createWebApp({
    adapter,
    clientEntry: "/c.js",
    manifest: manifestOf({ "/": () => ({ default: "home", revalidate: 60 }) }),
    csp: createCspPolicy({ header }),
  })
  const first = await app.fetch(new Request("http://x/"))
  const html = await first.text()
  expect(html).not.toContain("nonce=")
  expect(first.headers.get("cache-control")).toBeNull()
  expect(first.headers.get("x-nifra-isr-revalidate")).toBe("60")
  const policy = first.headers.get("content-security-policy") ?? ""
  expect(policy).not.toContain("'nonce-")
  // The browser's own check: each executable inline script's hash is in the policy.
  const scripts = executableInlineScripts(html)
  expect(scripts.length).toBe(2) // the form guard + the adapter's hydration head
  for (const { body } of scripts) expect(policy).toContain(await sha256Source(body))
  // The page state is the inert handover, not an executable script.
  expect(html).toContain('<script type="application/json" id="__nifra-handover">')
  // Identical header on the next request: nothing request-specific is in it.
  const second = await app.fetch(new Request("http://x/"))
  expect(second.headers.get("content-security-policy")).toBe(policy)
  // The exported list is the same set, for a CSP set outside the app.
  expect(policy).toBe(header({ sources: (await nifraScriptHashes(adapter)).join(" ") }))
})

test("a deferred page, a meta script or a nonced link under a CSP policy carries a nonce and is no-store", async () => {
  const app = createWebApp({
    adapter,
    clientEntry: "/c.js",
    manifest: manifestOf({
      "/later": () => ({ default: "later", loader: () => ({ slow: defer(Promise.resolve(1)) }) }),
      "/boot": () => ({
        default: "boot",
        meta: ({ nonce }) =>
          nonce === undefined
            ? {}
            : { unsafeScript: [unsafeInlineScript("metaBoot()", { nonce })] },
      }),
      "/styled": () => ({
        default: "styled",
        meta: ({ nonce }) =>
          nonce === undefined ? {} : { link: [{ rel: "stylesheet", href: "/s.css", nonce }] },
      }),
    }),
    csp: createCspPolicy({ header }),
  })
  for (const path of ["/later", "/boot", "/styled"]) {
    const res = await app.fetch(new Request(`http://x${path}`))
    const html = await res.text()
    const nonce = html.match(/<script nonce="([^"]+)"/)?.[1]
    expect(nonce).toBeTruthy()
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`)
    for (const { attrs } of executableInlineScripts(html)) {
      expect(attrs).toContain(`nonce="${nonce}"`)
    }
  }
})

test("an adapter whose hydration head stops matching the hashed one falls back to a nonce", async () => {
  let head = "<script>globalThis.boot = 1</script>"
  const drifting: RenderAdapter = { ...adapter, hydrationHead: () => head }
  const csp = createCspPolicy({ header })
  const render = async () =>
    renderPage({ adapter: drifting, chain: [null], data: null, clientEntry: "/c.js", csp })
  expect((await render()).headers.get("content-security-policy")).not.toContain("'nonce-")
  head = "<script>globalThis.boot = 2</script>"
  const res = await render()
  expect(res.headers.get("content-security-policy")).toContain("'nonce-")
  expect(res.headers.get("cache-control")).toBe("private, no-store")
})

test("createWebApp refuses `csp` with `nonce`, and a csp value not made by createCspPolicy", () => {
  const base = { adapter, clientEntry: "/c.js", manifest: manifestOf({}) }
  expect(() =>
    createWebApp({ ...base, csp: createCspPolicy({ header }), nonce: createNonceResolver() }),
  ).toThrow(/`csp` or `nonce`/)
  expect(() => createWebApp({ ...base, csp: {} as never })).toThrow(/createCspPolicy/)
  expect(() => createCspPolicy({} as never)).toThrow(/header function/)
})

test("withISR caches a CSP page and replays its header; it warns when every page has a nonce", async () => {
  const manifest = manifestOf({ "/": () => ({ default: "home" }) })
  const csp = createWebApp({
    adapter,
    clientEntry: "/c.js",
    manifest,
    csp: createCspPolicy({ header }),
  })
  const store = new MemoryCacheStore()
  const isr = withISR(csp, { store, revalidate: 60, now: () => 0 })
  const miss = await isr(new Request("http://x/"))
  expect(miss.headers.get("x-nifra-isr")).toBe("miss")
  const hit = await isr(new Request("http://x/"))
  expect(hit.headers.get("x-nifra-isr")).toBe("hit")
  expect(hit.headers.get("content-security-policy")).toBe(
    miss.headers.get("content-security-policy"),
  )
  expect(await hit.text()).toBe(await miss.text())

  const warn = console.warn
  const warnings: unknown[] = []
  console.warn = (message: unknown) => void warnings.push(message)
  try {
    withISR(
      createWebApp({ adapter, clientEntry: "/c.js", manifest, nonce: createNonceResolver() }),
      {
        store,
        revalidate: 60,
        now: () => 0,
      },
    )
    withISR(csp, { store, revalidate: 60, now: () => 0 })
  } finally {
    console.warn = warn
  }
  expect(warnings).toHaveLength(1)
  expect(String(warnings[0])).toContain("never store a page")
})
