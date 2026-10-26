import { describe, expect, test } from "bun:test"
import { cspHeaderValue, prepareCspPolicy } from "../src/csp.ts"
import {
  createCspPolicy,
  createNonceResolver,
  createWebApp,
  defer,
  gone,
  type Manifest,
  MemoryCacheStore,
  nifraScriptHashes,
  type RenderAdapter,
  type RouteModule,
  renderPage,
  unsafeInlineScript,
  withISR,
} from "../src/index.ts"
import { openCacheChannel } from "../src/isr.ts"

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
  [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)]
    .map((m) => ({ attrs: m[1] ?? "", body: m[2] ?? "" }))
    .filter((s) => !/\bsrc=/.test(s.attrs) && !s.attrs.includes('type="application/json"'))

test("a plain page under a CSP policy is nonce-free, cacheable, and every inline script is hashed", async () => {
  const app = createWebApp({
    adapter,
    clientEntry: "/c.js",
    manifest: manifestOf({ "/": () => ({ default: "home", revalidate: 60 }) }),
    csp: createCspPolicy({ header }),
  })
  openCacheChannel(app)
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

/** Whether the policy lets every executable inline script in `html` run: by its nonce or its hash. */
async function everyInlineScriptAllowed(html: string, policy: string): Promise<boolean> {
  for (const { attrs, body } of executableInlineScripts(html)) {
    const nonce = attrs.match(/\bnonce="([^"]+)"/)?.[1]
    if (nonce !== undefined && policy.includes(`'nonce-${nonce}'`)) continue
    if (!policy.includes(await sha256Source(body))) return false
  }
  return true
}

test("a render that writes a script of its own keeps the nonce it was handed; one that writes none drops it", async () => {
  // Like Solid serializing a caught server error: a script only some renders write.
  const serializing: RenderAdapter = {
    ...adapter,
    renderToString: (_chain, props, options) =>
      props.data === "error" && options?.nonce !== undefined
        ? `<p>fallback</p><script nonce="${options.nonce}">self.$R=["boom"]</script>`
        : props.data === "error"
          ? `<p>fallback</p><script>self.$R=["boom"]</script>`
          : "<p>plain</p>",
  }
  const csp = createCspPolicy({ header })
  const render = (data: string) =>
    renderPage({ adapter: serializing, chain: [null], data, clientEntry: "/c.js", csp })
  const failed = await render("error")
  const failedHtml = await failed.text()
  const failedPolicy = failed.headers.get("content-security-policy") ?? ""
  expect(failedPolicy).toContain("'nonce-")
  expect(failed.headers.get("cache-control")).toBe("private, no-store")
  expect(await everyInlineScriptAllowed(failedHtml, failedPolicy)).toBe(true)
  const plain = await render("plain")
  const plainHtml = await plain.text()
  const plainPolicy = plain.headers.get("content-security-policy") ?? ""
  expect([plainHtml.includes("nonce="), plainPolicy.includes("'nonce-")]).toEqual([false, false])
  expect(plain.headers.get("cache-control")).toBeNull()
  expect(await everyInlineScriptAllowed(plainHtml, plainPolicy)).toBe(true)
})

test("a render that suspends is streamed, with the nonce its streamed scripts need", async () => {
  const suspending: RenderAdapter = {
    ...adapter,
    renderToString: () => undefined,
    renderToStream: (_chain, _props, options) =>
      streamOf(`<p>resolved</p><script nonce="${options?.nonce ?? ""}">reveal()</script>`),
  }
  const csp = createCspPolicy({ header })
  const res = await renderPage({
    adapter: suspending,
    chain: [null],
    data: null,
    clientEntry: "/c.js",
    csp,
  })
  const html = await res.text()
  const policy = res.headers.get("content-security-policy") ?? ""
  expect(html).toContain("<p>resolved</p>")
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  expect(await everyInlineScriptAllowed(html, policy)).toBe(true)
  const open = await renderPage({
    adapter: suspending,
    chain: [null],
    data: null,
    clientEntry: "/c.js",
  })
  expect(await open.text()).toContain("<p>resolved</p>")
})

test("a page whose render suspended is streamed without another string render, for a while", async () => {
  let stringRenders = 0
  let suspends = true
  const counting: RenderAdapter = {
    ...adapter,
    renderToString: () => {
      stringRenders++
      return suspends ? undefined : "<p>buffered</p>"
    },
    renderToStream: () => streamOf("<p>streamed</p>"),
  }
  const Page = () => null
  const render = async () =>
    (
      await renderPage({ adapter: counting, chain: [Page], data: null, clientEntry: "/c.js" })
    ).text()
  expect(await render()).toContain("<p>streamed</p>")
  expect(stringRenders).toBe(1)
  suspends = false
  for (let i = 0; i < 32; i++) expect(await render()).toContain("<p>streamed</p>")
  expect(stringRenders).toBe(1)
  // The page stopped suspending (a `lazy` that loaded): it gets its buffered render back.
  expect(await render()).toContain("<p>buffered</p>")
  expect(stringRenders).toBe(2)
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

test("a hydration script is hashed however its closing tag is spaced", async () => {
  const spaced: RenderAdapter = {
    ...adapter,
    hydrationHead: () => "<script>globalThis.boot = 3</script >",
  }
  expect(await nifraScriptHashes(spaced)).toContain(await sha256Source("globalThis.boot = 3"))
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

test("a policy hashes once per adapter, retries a failed digest, and refuses use before it is ready", async () => {
  const policy = createCspPolicy({ header: ({ sources }) => `script-src 'self' ${sources}` })
  let heads = 0
  const flaky: RenderAdapter = {
    renderToStream: adapter.renderToStream,
    hydrationHead: () => {
      heads++
      if (heads === 2) throw new Error("head unavailable")
      return "<script>globalThis.boot = 2</script>"
    },
  }
  expect(() => cspHeaderValue(policy, flaky, undefined)).toThrow(/before prepareCspPolicy resolved/)
  await expect(prepareCspPolicy(policy, flaky)).rejects.toThrow("head unavailable")
  // The failure pinned nothing: the next document prepares again, and a concurrent one waits on it.
  const first = prepareCspPolicy(policy, flaky)
  const second = prepareCspPolicy(policy, flaky)
  await Promise.all([first, second])
  expect(prepareCspPolicy(policy, flaky)).toBeUndefined()
  expect(cspHeaderValue(policy, flaky, undefined)).toContain("'sha256-")
})

test("a nonce resolver refuses an empty generated nonce, and the request can ask again", async () => {
  let calls = 0
  const resolver = createNonceResolver({ generate: () => (++calls === 1 ? "  " : "abc123") })
  const request = new Request("http://localhost/")
  await expect(Promise.resolve(resolver({ request, env: undefined }))).rejects.toThrow(
    /empty CSP nonce/,
  )
  expect(await resolver({ request, env: undefined })).toBe("abc123")
  expect(resolver.get?.(request)).toBe("abc123")
})

describe("createWebApp({ nonce, cspHeader })", () => {
  const nonceApp = (
    manifest: Manifest,
    nonce = createNonceResolver(),
  ): ReturnType<typeof createWebApp> =>
    createWebApp({ adapter, clientEntry: "/c.js", manifest, nonce, cspHeader: header })

  /** The one nonce every executable inline script carries, or `undefined` when they carry none. */
  const scriptNonce = (html: string): string | undefined => {
    const nonces = new Set(
      executableInlineScripts(html).map(({ attrs }) => attrs.match(/\bnonce="([^"]+)"/)?.[1]),
    )
    expect(nonces.size).toBeLessThanOrEqual(1)
    return [...nonces][0]
  }

  test("the header names the nonce on the scripts, however the request was rebuilt in front", async () => {
    const app = nonceApp(
      manifestOf({
        "/": () => ({ default: "home" }),
        "/later": () => ({ default: "later", loader: () => ({ slow: defer(Promise.resolve(1)) }) }),
      }),
    )
    // A prefix-stripping mount, a request id, a public-origin rewrite: each builds a new Request.
    const wrapped = (req: Request) => {
      const rebuilt = new Request(req.url.replace("http://public", "http://x"), req)
      rebuilt.headers.set("x-request-id", "r1")
      return app.fetch(new Request(rebuilt.url, rebuilt))
    }
    for (const path of ["/", "/later"]) {
      const res = await wrapped(new Request(`http://public${path}`))
      const html = await res.text()
      const nonce = scriptNonce(html)
      expect(nonce).toBeTruthy()
      const policy = res.headers.get("content-security-policy") ?? ""
      expect(policy).toContain(`'nonce-${nonce}'`)
      expect(await everyInlineScriptAllowed(html, policy)).toBe(true)
      expect(res.headers.get("cache-control")).toBe("private, no-store")
    }
  })

  test("status pages and the _error boundary carry the header too", async () => {
    const manifest: Manifest = {
      routes: [
        {
          id: "gone",
          pattern: "/gone",
          layoutIds: [],
          file: "gone.tsx",
          load: async () => ({ default: "gone", loader: () => gone() }),
        },
        {
          id: "boom",
          pattern: "/boom",
          layoutIds: [],
          errorIds: ["_error"],
          file: "boom.tsx",
          load: async () => ({
            default: "boom",
            loader: () => {
              throw new Error("boom")
            },
          }),
        },
      ],
      layouts: {},
      errors: { _error: { file: "_error.tsx", load: async () => ({ default: "error" }) } },
      notFound: { file: "_404.tsx", load: async () => ({ default: "not-found" }) },
      statusPages: { "410": { file: "_410.tsx", load: async () => ({ default: "gone-page" }) } },
    }
    const app = nonceApp(manifest)
    for (const [path, status] of [
      ["/missing", 404],
      ["/gone", 410],
      ["/boom", 500],
    ] as const) {
      const res = await app.fetch(new Request(`http://x${path}`))
      const html = await res.text()
      expect([path, res.status]).toEqual([path, status])
      const policy = res.headers.get("content-security-policy") ?? ""
      expect(policy).toContain("'nonce-")
      // The `_error` document does not hydrate, so it has no inline script to name the nonce.
      const nonce = scriptNonce(html)
      if (path !== "/boom") expect(policy).toContain(`'nonce-${nonce}'`)
      expect(await everyInlineScriptAllowed(html, policy)).toBe(true)
      expect(res.headers.get("cache-control")).toBe("private, no-store")
    }
  })

  test("a document the resolver leaves nonce-free gets the hash sources alone, and stays cacheable", async () => {
    const app = nonceApp(
      manifestOf({ "/": () => ({ default: "home" }) }),
      createNonceResolver({ generate: () => undefined }),
    )
    const res = await app.fetch(new Request("http://x/"))
    const html = await res.text()
    expect(html).not.toContain("nonce=")
    const policy = res.headers.get("content-security-policy") ?? ""
    expect(policy).not.toContain("'nonce-")
    expect(await everyInlineScriptAllowed(html, policy)).toBe(true)
    expect(res.headers.get("cache-control")).toBeNull()
  })

  test("a nonce-free request whose document streams a deferred value gets a fresh nonce in the header", async () => {
    const app = nonceApp(
      manifestOf({
        "/later": () => ({ default: "later", loader: () => ({ slow: defer(Promise.resolve(1)) }) }),
      }),
      createNonceResolver({ generate: () => undefined }),
    )
    const res = await app.fetch(new Request("http://x/later"))
    const html = await res.text()
    const nonce = scriptNonce(html)
    expect(nonce).toBeTruthy()
    const policy = res.headers.get("content-security-policy") ?? ""
    expect(policy).toContain(`'nonce-${nonce}'`)
    expect(await everyInlineScriptAllowed(html, policy)).toBe(true)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("a nonce outside the CSP base64 grammar never reaches the header", async () => {
    const app = nonceApp(
      manifestOf({ "/": () => ({ default: "home" }) }),
      createNonceResolver({ generate: () => "x' 'unsafe-inline" }),
    )
    const res = await app.fetch(new Request("http://x/"))
    const policy = res.headers.get("content-security-policy") ?? ""
    expect([res.status >= 500, policy.includes("unsafe-inline")]).toEqual([true, false])
  })

  test("an API response gets no header, and `undefined` from the callback sends none", async () => {
    const withApi = (cspHeader: typeof header | (() => undefined)) =>
      createWebApp({
        adapter,
        clientEntry: "/c.js",
        manifest: manifestOf({ "/": () => ({ default: "home" }) }),
        nonce: createNonceResolver(),
        cspHeader,
        use: (inner) => inner.get("/api/ping", () => ({ ok: true })),
      })
    const api = await withApi(header).fetch(new Request("http://x/api/ping"))
    expect([api.status, api.headers.get("content-security-policy")]).toEqual([200, null])
    const page = await withApi(() => undefined).fetch(new Request("http://x/"))
    expect(page.headers.get("content-security-policy")).toBeNull()
    expect(page.headers.get("cache-control")).toBe("private, no-store")
  })

  test("cspHeader is refused beside `csp`, without `nonce`, or beside a resolver's own header", () => {
    const base = { adapter, clientEntry: "/c.js", manifest: manifestOf({}) }
    expect(() =>
      createWebApp({ ...base, csp: createCspPolicy({ header }), cspHeader: header }),
    ).toThrow(/`csp` or `cspHeader`/)
    expect(() => createWebApp({ ...base, cspHeader: header })).toThrow(/pass `nonce`/)
    expect(() =>
      createWebApp({
        ...base,
        nonce: createNonceResolver({ header: ({ nonce }) => `script-src 'nonce-${nonce}'` }),
        cspHeader: header,
      }),
    ).toThrow(/keep one/)
    expect(() =>
      createWebApp({
        ...base,
        nonce: createNonceResolver(),
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a wrong type on purpose, for the runtime check that plain JavaScript callers reach.
        cspHeader: "x" as never,
      }),
    ).toThrow(/must be a function/)
  })
})
