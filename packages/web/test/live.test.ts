import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test"
import {
  createWebApp,
  defer,
  type LayoutEntry,
  type Manifest,
  notFound,
  type RenderAdapter,
} from "../src/index.ts"
import { createKeyring, type GrantInput, type LiveSecrets } from "../src/live/keyring.ts"
import { type Live, type LiveOptions, live, memoryBus } from "../src/live.ts"
import type { LoaderContext } from "../src/manifest.ts"
import { DATA_HEADER, NAV_FROM_HEADER, RETAIN_HEADER } from "../src/router.ts"

const SECRET = "s".repeat(32)
const OLD_SECRET = "o".repeat(32)
const APP_ID = "live-test"
const ORIGIN = "http://app.test"
const LOAD = `${ORIGIN}/_nifra/live/load`
const SID = "0123456789abcdef0123456789abcdef"
const OTHER_SID = "f".repeat(32)
const PAGE = "P:posts/[id]"
const ROOT = "L:_layout"
const POSTS = "L:posts/_layout"
const GATE = "L:posts/_gate"
const ALL = [ROOT, POSTS, GATE, PAGE]

const streamOf = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

const stub: RenderAdapter = {
  renderToStream: (_chain, props) => streamOf(`<p>${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "",
}

type Loader = (ctx: LoaderContext) => unknown

interface Fixture {
  readonly app: ReturnType<typeof createWebApp>
  readonly runtime: Live
  readonly calls: Record<string, number>
}

interface FixtureOptions {
  readonly live?: Partial<LiveOptions>
  readonly use?: (app: ReturnType<typeof createWebApp>) => void
  readonly page?: Loader
  readonly root?: Loader
  readonly runtime?: Live
}

const userOf = (request: Request): string | null =>
  /(?:^|;\s*)user=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? null

/** Root and posts layouts, a gate, and a post page, each counting its runs and declaring keys. */
const fixture = (options: FixtureOptions = {}): Fixture => {
  const calls: Record<string, number> = {}
  const hit = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  const root = options.root
  const runtime =
    options.runtime ??
    live({ secret: SECRET, appId: APP_ID, subject: (ctx) => userOf(ctx.request), ...options.live })
  const layout = (name: string, key: string, gate = false): LayoutEntry => ({
    file: `${name}.tsx`,
    load: async () => ({
      default: name,
      gate,
      loader: (ctx: LoaderContext) => {
        hit(name)
        ctx.live(key)
        return { layout: name }
      },
    }),
  })
  const manifest: Manifest = {
    routes: [
      {
        id: "posts/[id]",
        pattern: "/posts/:id",
        layoutIds: ["_layout", "posts/_layout", "posts/_gate"],
        layoutParams: [[], [], []],
        file: "posts/[id].tsx",
        load: async () => ({
          default: "post",
          loader:
            options.page ??
            ((ctx: LoaderContext) => {
              hit("page")
              ctx.live(`post:${ctx.params.id}`, `comments:${ctx.params.id}`)
              return { id: ctx.params.id }
            }),
        }),
      },
      {
        id: "about",
        pattern: "/about",
        layoutIds: ["_layout"],
        layoutParams: [[]],
        file: "about.tsx",
        load: async () => ({
          default: "about",
          loader: (ctx: LoaderContext) => {
            hit("about")
            ctx.live("about")
            return { about: true }
          },
        }),
      },
    ],
    layouts: {
      _layout:
        root === undefined
          ? layout("root", "site:nav")
          : { file: "root.tsx", load: async () => ({ default: "root", loader: root }) },
      "posts/_layout": layout("posts", "posts:list"),
      "posts/_gate": layout("gate", "gate:key", true),
    },
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  const app = createWebApp({
    adapter: stub,
    manifest,
    clientEntry: "/c.js",
    live: runtime,
    use: options.use ?? (() => {}),
  })
  return { app, runtime, calls }
}

interface LoadBody {
  path?: unknown
  sid?: unknown
  frame?: unknown
  mode?: unknown
  retain?: unknown
  grants?: unknown
}

const BROWSER = {
  cookie: "user=alice",
  "user-agent": "test-browser",
  "accept-language": "en",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  accept: "*/*",
}

const postLoad = (
  app: Fixture["app"],
  body: LoadBody,
  headers: Record<string, string> = {},
): Promise<Response> =>
  Promise.resolve(
    app.fetch(
      new Request(LOAD, {
        method: "POST",
        headers: {
          ...BROWSER,
          origin: ORIGIN,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    ),
  )

interface LiveJson {
  v?: number
  data?: unknown
  layoutData?: unknown[]
  retained?: number[]
  live?: {
    subject: string
    grant?: string
    tags?: Record<string, string[]>
    page?: string
    ttl?: number
  }
  error?: string
}

const load = async (
  app: Fixture["app"],
  body: LoadBody = {},
  headers: Record<string, string> = {},
): Promise<{ res: Response; json: LiveJson }> => {
  const res = await postLoad(
    app,
    { path: "/posts/42", sid: SID, frame: "page", mode: "load", retain: [], grants: [], ...body },
    headers,
  )
  const text = await res.text()
  let json: LiveJson = {}
  try {
    json = JSON.parse(text)
  } catch {
    json = {}
  }
  return { res, json }
}

/** A seq no older than any fixture's bus head. */
const nowSeq = (): number => Date.now() * 1000

const testKeyring = (secrets: LiveSecrets = [SECRET], ttl = 600) =>
  createKeyring({ secrets, appId: APP_ID, ttl })

const opened = async (grant: string | undefined, secrets: LiveSecrets = [SECRET]) =>
  (await (await testKeyring(secrets)).open(grant, Date.now()))?.claims

/** A first load, then a load presenting its grant and asking to keep `retain`. */
const reload = async (
  fx: Fixture,
  retain: readonly string[],
  body: LoadBody = {},
  headers: Record<string, string> = {},
) => {
  const first = await load(fx.app, {}, headers)
  expect(first.json.live?.grant).toBeDefined()
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  return load(fx.app, { retain, grants: [first.json.live?.grant], ...body }, headers)
}

const ENV = process.env.NODE_ENV
afterEach(() => {
  if (ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ENV
  setSystemTime()
})

// --- Keys and grants ---------------------------------------------------------------------------

test("a live load runs every loader and returns a grant for exactly the keys they declared", async () => {
  const fx = fixture()
  const { res, json } = await load(fx.app)
  expect(res.status).toBe(200)
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  expect(res.headers.get("vary")).toContain(DATA_HEADER)
  expect(fx.calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
  expect(json.data).toEqual({ id: "42" })
  const claims = await opened(json.live?.grant)
  expect(claims?.sid).toBe(SID)
  expect(claims?.sub).toBe("alice")
  expect(claims?.path).toBe("/posts/42")
  expect(claims?.frame).toBe("page")
  expect(
    Object.fromEntries(Object.entries(claims?.owners ?? {}).map(([o, v]) => [o, v.k])),
  ).toEqual({
    [ROOT]: ["site:nav"],
    [POSTS]: ["posts:list"],
    [GATE]: ["gate:key"],
    [PAGE]: ["post:42", "comments:42"],
  })
})

test("the tag map holds only the frame's own keys, as tags of the grant's secret", async () => {
  const fx = fixture()
  const { json } = await load(fx.app)
  const keyring = await testKeyring()
  const keys = ["site:nav", "posts:list", "gate:key", "post:42", "comments:42"]
  const tags = await Promise.all(keys.map((key) => keyring.tag(key)))
  const owners = [[ROOT], [POSTS], [GATE], [PAGE], [PAGE]]
  expect(json.live?.tags).toEqual(Object.fromEntries(tags.map((tag, i) => [tag, owners[i] ?? []])))
  // No key text anywhere on the wire.
  const wire = JSON.stringify(json.live)
  for (const key of keys) expect(wire.includes(key)).toBe(false)
  expect(wire.includes("alice")).toBe(false)
})

test("a key two owners declare maps its one tag to both owners", async () => {
  const fx = fixture({
    root: (ctx) => {
      ctx.live("post:42")
      return null
    },
  })
  const { json } = await load(fx.app)
  const tag = await (await testKeyring()).tag("post:42")
  expect(json.live?.tags?.[tag]).toEqual([ROOT, PAGE])
})

test("a loader that throws drops every key: no grant", async () => {
  const fx = fixture({
    page: (ctx) => {
      ctx.live("post:42")
      throw new Error("boom")
    },
  })
  const { res, json } = await load(fx.app)
  expect(res.status).toBe(500)
  expect(json.live).toBeUndefined()
})

test("a loader that answers with a status drops every key: no grant", async () => {
  const fx = fixture({
    page: (ctx) => {
      ctx.live("post:42")
      notFound()
    },
  })
  const { res, json } = await load(fx.app)
  expect(res.status).toBe(404)
  expect(json.live).toBeUndefined()
})

test("a layout that returns a redirect drops every key: no grant", async () => {
  const fx = fixture({
    root: (ctx) => {
      ctx.live("site:nav")
      return Response.redirect(`${ORIGIN}/login`, 302)
    },
  })
  const { json } = await load(fx.app)
  expect(json.live).toBeUndefined()
})

test("keys declared after the loader settled are refused", async () => {
  let late: ((...keys: string[]) => void) | undefined
  const fx = fixture({
    page: (ctx) => {
      late = ctx.live
      return { id: "42" }
    },
  })
  await load(fx.app)
  expect(() => late?.("post:42")).toThrow(/after the loader/)
})

test("a key outside the cache-tag charset is a loader error", async () => {
  const fx = fixture({
    page: (ctx) => {
      ctx.live("has space")
      return null
    },
  })
  const { res, json } = await load(fx.app)
  expect(res.status).toBe(500)
  expect(json.live).toBeUndefined()
})

test("over 64 keys per frame is a development error", async () => {
  const fx = fixture({
    root: (ctx) => {
      for (let i = 0; i < 30; i++) ctx.live(`root:${i}`, `root:${i}`)
      return null
    },
    page: (ctx) => {
      for (let i = 0; i < 35; i++) ctx.live(`page:${i}`)
      return null
    },
  })
  const { res, json } = await load(fx.app)
  expect(res.status).toBe(500)
  expect(json.live).toBeUndefined()
})

test("over 64 keys in production issues no grant and logs the route and count, never the keys", async () => {
  process.env.NODE_ENV = "production"
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    const fx = fixture({
      page: (ctx) => {
        for (let i = 0; i < 70; i++) ctx.live(`secret-key-${i}`)
        return { id: "42" }
      },
    })
    const { res, json } = await load(fx.app)
    expect(res.status).toBe(200)
    expect(json.data).toEqual({ id: "42" })
    expect(json.live?.grant).toBeUndefined()
    expect(json.live?.subject).toBeDefined()
    const logged = error.mock.calls.map((call) => String(call[0])).join("\n")
    expect(logged).toContain('route "posts/[id]"')
    expect(logged).toContain("73 keys")
    expect(logged.includes("secret-key")).toBe(false)
  } finally {
    error.mockRestore()
  }
})

test("retained and fresh keys together past the budget issue no grant in production", async () => {
  process.env.NODE_ENV = "production"
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    const fx = fixture()
    const keyring = await testKeyring()
    // 61 kept plus the 4 the fresh owners declare: one over.
    const many = Array.from({ length: 61 }, (_, i) => `kept:${i}`)
    const grant = await keyring.seal(
      {
        sid: SID,
        sub: "alice",
        path: "/posts/42",
        frame: "page",
        owners: { [ROOT]: { k: many, w: 0 } },
        s: nowSeq(),
        r: 0,
      },
      Date.now(),
    )
    const { json } = await load(fx.app, { retain: [ROOT], grants: [grant] })
    expect(fx.calls.root).toBeUndefined()
    expect(json.live?.grant).toBeUndefined()
    expect(String(error.mock.calls[0]?.[0])).toContain("declared 65 keys")
  } finally {
    error.mockRestore()
  }
})

test("a grant too large to carry is not issued; the client polls", async () => {
  process.env.NODE_ENV = "production"
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    const fx = fixture({
      page: (ctx) => {
        // With the layouts' 3, exactly the 64-key budget, but too many bytes.
        for (let i = 0; i < 61; i++) ctx.live(`k${i}`.padEnd(128, "x"))
        return null
      },
    })
    const { json } = await load(fx.app)
    expect(json.live?.grant).toBeUndefined()
    expect(String(error.mock.calls[0]?.[0])).toContain("no grant issued")
  } finally {
    error.mockRestore()
  }
})

test("ctx.live does nothing outside a live load: navigations keep their exact payload", async () => {
  const fx = fixture()
  const res = await fx.app.fetch(
    new Request(`${ORIGIN}/posts/42`, { headers: { ...BROWSER, [DATA_HEADER]: "1" } }),
  )
  const json: LiveJson = await res.json()
  expect(json.live).toBeUndefined()
  expect(json.data).toEqual({ id: "42" })
  const doc = await (await fx.app.fetch(new Request(`${ORIGIN}/posts/42`))).text()
  expect(doc).not.toContain("grant")
})

test("ctx.live is a no-op in an app without live", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: {
      routes: [
        {
          id: "p",
          layoutParams: [],
          pattern: "/p",
          layoutIds: [],
          file: "p.tsx",
          load: async () => ({
            default: "p",
            loader: (ctx: LoaderContext) => {
              ctx.live("post:1")
              return { ok: true }
            },
          }),
        },
      ],
      layouts: {},
      notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
    },
    clientEntry: "/c.js",
  })
  const res = await app.fetch(new Request(`${ORIGIN}/p`, { headers: { [DATA_HEADER]: "1" } }))
  // The bare payload a layout-free route has always answered with.
  expect(await res.json()).toEqual({ ok: true })
  const post = await app.fetch(
    new Request(LOAD, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    }),
  )
  // No endpoint exists: the POST falls through to the app's own routing.
  expect([404, 405]).toContain(post.status)
})

// --- Retention ---------------------------------------------------------------------------------

test("a retained live load skips exactly the offered loaders; gates always run", async () => {
  const fx = fixture()
  const { json } = await reload(fx, ALL)
  expect(fx.calls).toEqual({ gate: 1 })
  expect(json.retained).toEqual([0, 1])
  expect(json.live?.page).toBe("retained")
  expect(json.data).toBeNull()
  const claims = await opened(json.live?.grant)
  expect(Object.keys(claims?.owners ?? {}).sort()).toEqual([...ALL].sort())
})

test("offering one owner keeps only that owner", async () => {
  const fx = fixture()
  const { json } = await reload(fx, [ROOT])
  expect(fx.calls).toEqual({ posts: 1, gate: 1, page: 1 })
  expect(json.retained).toEqual([0])
  expect(json.live?.page).toBeUndefined()
})

test("unknown, malformed and foreign owner ids load fresh", async () => {
  const fx = fixture()
  const { json } = await reload(fx, ["L:nope", "P:about", "X:_layout", "L:", "P:", POSTS])
  expect(fx.calls).toEqual({ root: 1, gate: 1, page: 1 })
  expect(json.retained).toEqual([1])
})

test("retained owners keep their watermarks; fresh owners take the load's seq", async () => {
  const fx = fixture()
  const first = await load(fx.app)
  // Any revocation advances the sequence.
  await fx.runtime.revokeKey("unrelated")
  const { json } = await load(fx.app, { retain: [ROOT], grants: [first.json.live?.grant] })
  const before = await opened(first.json.live?.grant)
  const after = await opened(json.live?.grant)
  expect(after?.owners[ROOT]?.w).toBe(before?.owners[ROOT]?.w ?? -1)
  expect(after?.owners[PAGE]?.w).toBeGreaterThan(
    before?.owners[PAGE]?.w ?? Number.POSITIVE_INFINITY,
  )
  expect(after?.s).toBeGreaterThan(before?.s ?? Number.POSITIVE_INFINITY)
})

test("a retained live load sends x-nifra-from and x-nifra-retain as the router does", async () => {
  const seen: Request[] = []
  const fx = fixture({
    use: (app) =>
      app.onRequest((req) => {
        seen.push(req)
      }),
  })
  const first = await load(fx.app)
  seen.length = 0
  await load(fx.app, { retain: [POSTS, ROOT], grants: [first.json.live?.grant] })
  expect(seen).toHaveLength(1)
  expect(seen[0]?.method).toBe("GET")
  expect(seen[0]?.url).toBe(`${ORIGIN}/posts/42`)
  expect(seen[0]?.headers.get(RETAIN_HEADER)).toBe("0,1")
  expect(seen[0]?.headers.get(NAV_FROM_HEADER)).toBe("/posts/42")
})

test("a navigation presenting the page it leaves keeps only the layouts a router navigation would", async () => {
  const seen: Request[] = []
  const fx = fixture({
    use: (app) =>
      app.onRequest((req) => {
        seen.push(req)
      }),
  })
  const first = await load(fx.app)
  const grant = first.json.live?.grant
  const navigate = async (path: string, mode: "load" | "renew" = "load") => {
    for (const key of Object.keys(fx.calls)) delete fx.calls[key]
    seen.length = 0
    const { json } = await load(fx.app, { path, mode, retain: ALL, grants: [grant] })
    return { json, calls: { ...fx.calls }, from: seen[0]?.headers.get(NAV_FROM_HEADER) ?? null }
  }

  // The shared root layout carries over; the page loader always runs on another path.
  const about = await navigate("/about")
  expect(about.calls).toEqual({ about: 1 })
  expect(about.from).toBe("/posts/42")
  expect(about.json.live?.page).toBeUndefined()
  expect(about.json.live?.ttl).toBe(600)
  const kept = await opened(about.json.live?.grant)
  expect(Object.keys(kept?.owners ?? {}).sort()).toEqual([ROOT, "P:about"])
  expect(kept?.owners[ROOT]).toEqual((await opened(grant))?.owners[ROOT])

  const sibling = await navigate("/posts/43")
  expect(sibling.calls).toEqual({ gate: 1, page: 1 })

  // A query change re-runs every layout, as it does for the router.
  expect((await navigate("/posts/43?tab=1")).calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
  // A renewal is for its own page only.
  expect((await navigate("/about", "renew")).calls).toEqual({ root: 1, about: 1 })
})

test("a retained live load keeps layouts exactly as the router's navigation would", async () => {
  const fx = fixture()
  const { json } = await reload(fx, [ROOT, POSTS])
  const router = fixture()
  const res = await router.app.fetch(
    new Request(`${ORIGIN}/posts/42`, {
      headers: {
        ...BROWSER,
        [DATA_HEADER]: "1",
        [RETAIN_HEADER]: "0,1",
        [NAV_FROM_HEADER]: "/posts/42",
      },
    }),
  )
  const nav: LiveJson = await res.json()
  expect(json.retained).toEqual(nav.retained ?? [-1])
  expect(json.layoutData).toEqual(nav.layoutData ?? [-1])
  expect(json.data).toEqual(nav.data)
  expect(router.calls).toEqual(fx.calls)
})

test("page retention exists only on a live-marked load: no header or body turns it on", async () => {
  const fx = fixture()
  const res = await fx.app.fetch(
    new Request(`${ORIGIN}/posts/42`, {
      headers: {
        ...BROWSER,
        [DATA_HEADER]: "1",
        [RETAIN_HEADER]: "0,1,2,3,page",
        [NAV_FROM_HEADER]: "/posts/42",
        "x-nifra-live": "1",
        "x-nifra-retain-page": "1",
      },
    }),
  )
  const json: LiveJson = await res.json()
  expect(fx.calls.page).toBe(1)
  expect(json.live).toBeUndefined()
  // The body's page owner without a grant keeps nothing either.
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  await load(fx.app, { retain: ALL })
  expect(fx.calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
})

test("page retention never carries to another route an app hook rewrote the load to", async () => {
  const fx = fixture({
    use: (app) =>
      app.onRequest((req) =>
        req.headers.get("x-rewrite") === "about" ? new Request(`${ORIGIN}/about`, req) : undefined,
      ),
  })
  const first = await load(fx.app)
  const { json } = await load(
    fx.app,
    { retain: ALL, grants: [first.json.live?.grant] },
    { "x-rewrite": "about" },
  )
  expect(fx.calls.about).toBe(1)
  expect(json.live?.page).toBeUndefined()
  expect(json.data).toEqual({ about: true })
})

test("a load an app hook replaces is still the same live load", async () => {
  const fx = fixture({
    use: (app) =>
      app.onRequest((req) => {
        const headers = new Headers(req.headers)
        headers.set("x-app", "1")
        return new Request(req, { headers })
      }),
  })
  const first = await load(fx.app)
  expect(first.json.live?.grant).toBeDefined()
})

test("owners an app hook adds to the retain header without a grant behind them get no grant", async () => {
  const fx = fixture({
    use: (app) =>
      app.onRequest((req) => {
        if (req.headers.get(RETAIN_HEADER) === null) return undefined
        const headers = new Headers(req.headers)
        headers.set(RETAIN_HEADER, "0,1")
        return new Request(req.url, { headers })
      }),
  })
  const keyring = await testKeyring()
  const grant = await keyring.seal(
    {
      sid: SID,
      sub: "alice",
      path: "/posts/42",
      frame: "page",
      owners: { [ROOT]: { k: ["site:nav"], w: 0 } },
      s: nowSeq(),
      r: 0,
    },
    Date.now(),
  )
  const { json } = await load(fx.app, { retain: [ROOT], grants: [grant] })
  expect(json.retained).toEqual([0, 1])
  expect(json.live?.grant).toBeUndefined()
})

// --- Grant binding -----------------------------------------------------------------------------

test("a grant for another socket or frame keeps nothing", async () => {
  const fx = fixture()
  const first = await load(fx.app)
  const grant = first.json.live?.grant
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  await load(fx.app, { retain: ALL, grants: [grant], sid: OTHER_SID })
  expect(fx.calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
  const modal = await (await testKeyring()).seal(
    {
      sid: SID,
      sub: "alice",
      path: "/posts/42",
      frame: "modal",
      owners: { [ROOT]: { k: [], w: 0 } },
      s: nowSeq(),
      r: 0,
    },
    Date.now(),
  )
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  await load(fx.app, { retain: ALL, grants: [modal] })
  expect(fx.calls.root).toBe(1)
})

test("a grant issued to another viewer keeps nothing, and the subject tag changes", async () => {
  const fx = fixture()
  const first = await load(fx.app)
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  const { json } = await load(
    fx.app,
    { retain: ALL, grants: [first.json.live?.grant] },
    { cookie: "user=bob" },
  )
  expect(fx.calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
  expect(json.live?.page).toBeUndefined()
  expect(json.live?.subject).not.toBe(first.json.live?.subject ?? "")
  expect((await opened(json.live?.grant))?.sub).toBe("bob")
  const anonymous = await load(fx.app, {}, { cookie: "" })
  expect(anonymous.json.live?.subject).not.toBe(json.live?.subject ?? "")
  expect((await opened(anonymous.json.live?.grant))?.sub).toBeNull()
  const again = await load(fx.app)
  expect(again.json.live?.subject).toBe(first.json.live?.subject ?? "")
})

test("an expired grant, a forged one or another app's keeps nothing", async () => {
  const fx = fixture()
  const owners = { [ROOT]: { k: ["site:nav"], w: 0 }, [PAGE]: { k: [], w: 0 } }
  const claims: GrantInput = {
    sid: SID,
    sub: "alice",
    path: "/posts/42",
    frame: "page",
    owners,
    s: nowSeq(),
    r: 0,
  }
  const expired = await (await testKeyring()).seal(claims, Date.now() - 601_000)
  const otherApp = await (
    await createKeyring({ secrets: [SECRET], appId: "other", ttl: 600 })
  ).seal(claims, Date.now())
  const otherSecret = await (await testKeyring(["x".repeat(32)])).seal(claims, Date.now())
  for (const grant of [expired, otherApp, otherSecret, "forged", 42, ""]) {
    for (const key of Object.keys(fx.calls)) delete fx.calls[key]
    await load(fx.app, { retain: ALL, grants: typeof grant === "string" ? [grant] : [] })
    expect(fx.calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
  }
})

test("the first matching grant of up to three is used", async () => {
  const fx = fixture()
  const first = await load(fx.app)
  const { json } = await load(fx.app, {
    retain: [ROOT],
    grants: ["junk", first.json.live?.grant, "more junk"],
  })
  expect(json.retained).toEqual([0])
})

test("rotation: a grant under a demoted secret still keeps; the reissue moves to the new secret", async () => {
  // Two processes on one bus: the second honors grants the first issued.
  const bus = memoryBus()
  const before = fixture({ live: { secret: OLD_SECRET, bus } })
  const first = await load(before.app)
  const fx = fixture({ live: { secret: [SECRET, OLD_SECRET], bus } })
  const { json } = await load(fx.app, { retain: [ROOT], grants: [first.json.live?.grant] })
  expect(fx.calls.root).toBeUndefined()
  expect(await opened(json.live?.grant)).toBeDefined()
  expect(await opened(json.live?.grant, [OLD_SECRET])).toBeUndefined()
  const tag = await (await testKeyring()).tag("site:nav")
  expect(json.live?.tags?.[tag]).toEqual([ROOT])
})

// --- Revocation --------------------------------------------------------------------------------

test("revoke(subject) and revokeAll() refuse every older grant whole; newer grants keep", async () => {
  for (const revoke of [(rt: Live) => rt.revoke("alice"), (rt: Live) => rt.revokeAll()]) {
    const fx = fixture()
    const first = await load(fx.app)
    await revoke(fx.runtime)
    for (const key of Object.keys(fx.calls)) delete fx.calls[key]
    const { json } = await load(fx.app, { retain: ALL, grants: [first.json.live?.grant] })
    expect(fx.calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
    for (const key of Object.keys(fx.calls)) delete fx.calls[key]
    await load(fx.app, { retain: ALL, grants: [json.live?.grant] })
    expect(fx.calls).toEqual({ gate: 1 })
  }
})

test("revoking another subject leaves this grant alone", async () => {
  const fx = fixture()
  await fx.runtime.revoke("bob")
  const { json } = await reload(fx, ALL)
  expect(fx.calls).toEqual({ gate: 1 })
  expect(json.live?.grant).toBeDefined()
})

test("a revoked key's owner is neither kept nor re-signed: its loader runs and decides again", async () => {
  let allowed = true
  const fx = fixture({
    root: (ctx) => {
      if (allowed) ctx.live("site:nav")
      return null
    },
  })
  const first = await load(fx.app)
  allowed = false
  await fx.runtime.revokeKey("site:nav")
  const { json } = await load(fx.app, { retain: ALL, grants: [first.json.live?.grant] })
  expect(json.retained).toEqual([1])
  expect(json.live?.page).toBe("retained")
  const claims = await opened(json.live?.grant)
  expect(claims?.owners[ROOT]?.k).toEqual([])
  expect(claims?.owners[POSTS]?.k).toEqual(["posts:list"])
})

test("revokeKey for one subject affects only that subject's grants", async () => {
  const fx = fixture()
  const first = await load(fx.app)
  await fx.runtime.revokeKey("post:42", "bob")
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  await load(fx.app, { retain: ALL, grants: [first.json.live?.grant] })
  expect(fx.calls).toEqual({ gate: 1 })
  await fx.runtime.revokeKey("post:42", "alice")
  await fx.runtime.revokeKey("post:42", "carol")
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  const { json } = await load(fx.app, { retain: ALL, grants: [first.json.live?.grant] })
  expect(fx.calls).toEqual({ gate: 1, page: 1 })
  // The reissued grant is newer than the revocation, so the owner keeps again.
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  await load(fx.app, { retain: ALL, grants: [json.live?.grant] })
  expect(fx.calls).toEqual({ gate: 1 })
})

test("an anonymous grant is untouched by per-subject revocations", async () => {
  const fx = fixture()
  const first = await load(fx.app, {}, { cookie: "" })
  await fx.runtime.revokeKey("post:42", "alice")
  await fx.runtime.revoke("alice")
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  await load(fx.app, { retain: ALL, grants: [first.json.live?.grant] }, { cookie: "" })
  expect(fx.calls).toEqual({ gate: 1 })
})

test("revocations older than one grant lifetime are dropped", async () => {
  const start = Date.now()
  setSystemTime(start)
  const runtime = live({ secret: SECRET, appId: APP_ID, subject: () => "alice", grantTtl: 60 })
  await runtime.revoke("alice")
  await runtime.revokeKey("a", "alice")
  await runtime.revokeKey("b")
  setSystemTime(start + 61_000)
  await runtime.revokeKey("c")
  const fx = fixture({ runtime })
  setSystemTime()
  const { json } = await reload(fx, ALL)
  expect(json.live?.grant).toBeDefined()
})

test("revocation arguments are checked", async () => {
  const fx = fixture()
  await expect(Reflect.apply(fx.runtime.revoke, fx.runtime, [42])).rejects.toThrow(/subject/)
  await expect(fx.runtime.revokeKey("has space")).rejects.toThrow(/charset/)
})

// --- Renewal -----------------------------------------------------------------------------------

test("renew without live.authorize is a full load", async () => {
  const fx = fixture()
  const { json } = await reload(fx, [], { mode: "renew" })
  expect(fx.calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
  expect(json.live?.grant).toBeDefined()
})

test("renew with live.authorize re-signs the grant without loaders; gates still run", async () => {
  const asked: Array<{ keys: readonly string[]; url: string }> = []
  const fx = fixture({
    live: {
      authorize: (keys, ctx) => {
        asked.push({ keys: [...keys].sort(), url: ctx.request.url })
        return true
      },
    },
  })
  const first = await load(fx.app)
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  const { json } = await load(fx.app, { mode: "renew", grants: [first.json.live?.grant] })
  expect(fx.calls).toEqual({ gate: 1 })
  expect(json.live?.page).toBe("retained")
  expect(asked).toEqual([
    { keys: ["comments:42", "post:42", "posts:list", "site:nav"], url: `${ORIGIN}/posts/42` },
  ])
  const before = await opened(first.json.live?.grant)
  const after = await opened(json.live?.grant)
  expect(after?.owners).toEqual(before?.owners ?? {})
})

test("a quiet renewal chain is bounded: the third renew runs every loader and starts over", async () => {
  const fx = fixture({ live: { authorize: () => true } })
  let grant = (await load(fx.app)).json.live?.grant
  expect((await opened(grant))?.r).toBe(0)
  for (const expected of [1, 2]) {
    for (const key of Object.keys(fx.calls)) delete fx.calls[key]
    const renewed = await load(fx.app, { mode: "renew", grants: [grant] })
    expect(fx.calls).toEqual({ gate: 1 })
    grant = renewed.json.live?.grant
    expect((await opened(grant))?.r).toBe(expected)
  }
  // A retained load keeps the count: only a full load clears it.
  const kept = await load(fx.app, { retain: [ROOT], grants: [grant] })
  expect((await opened(kept.json.live?.grant))?.r).toBe(2)
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  const full = await load(fx.app, { mode: "renew", grants: [grant] })
  expect(fx.calls).toEqual({ root: 1, posts: 1, gate: 1, page: 1 })
  expect((await opened(full.json.live?.grant))?.r).toBe(0)
})

test("live.authorize refusing issues no grant", async () => {
  const fx = fixture({ live: { authorize: () => false } })
  const first = await load(fx.app)
  const renewed = await load(fx.app, { mode: "renew", grants: [first.json.live?.grant] })
  expect(renewed.json.live?.grant).toBeUndefined()
  expect(renewed.json.live?.subject).toBe(first.json.live?.subject ?? "")
  // A retained load is checked the same way.
  const kept = await load(fx.app, { retain: [ROOT], grants: [first.json.live?.grant] })
  expect(kept.json.live?.grant).toBeUndefined()
  // Nothing kept, nothing to authorize.
  const fresh = await load(fx.app, { retain: [], grants: [first.json.live?.grant] })
  expect(fresh.json.live?.grant).toBeDefined()
})

test("renew never re-signs a revoked key: that owner's loader runs", async () => {
  const asked: string[][] = []
  const fx = fixture({
    live: {
      authorize: (keys) => {
        asked.push([...keys].sort())
        return true
      },
    },
  })
  const first = await load(fx.app)
  await fx.runtime.revokeKey("post:42")
  for (const key of Object.keys(fx.calls)) delete fx.calls[key]
  await load(fx.app, { mode: "renew", grants: [first.json.live?.grant] })
  expect(fx.calls).toEqual({ gate: 1, page: 1 })
  expect(asked.at(-1)).toEqual(["posts:list", "site:nav"])
})

// --- The endpoint ------------------------------------------------------------------------------

test("origin: missing, foreign or opaque without Sec-Fetch-Site is refused", async () => {
  const fx = fixture({ live: { trustedOrigins: ["https://partner.test"] } })
  const refused = [
    { origin: "" },
    { origin: "https://evil.test" },
    { origin: "null" },
    { origin: "null", "sec-fetch-site": "cross-site" },
  ]
  for (const headers of refused) {
    const req = new Request(LOAD, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ path: "/posts/42", sid: SID, frame: "page", mode: "load" }),
    })
    if (headers.origin === "") req.headers.delete("origin")
    const res = await fx.app.fetch(req)
    expect({ headers, status: res.status }).toEqual({ headers, status: 403 })
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  }
  for (const origin of ["https://partner.test", "https://app.test"]) {
    expect((await load(fx.app, {}, { origin })).res.status).toBe(200)
  }
  expect(
    (await load(fx.app, {}, { origin: "null", "sec-fetch-site": "same-origin" })).res.status,
  ).toBe(200)
  expect(fx.calls.root).toBe(3)
})

test("content type must be JSON", async () => {
  const fx = fixture()
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    expect((await load(fx.app, {}, { "content-type": type })).res.status).toBe(415)
  }
  const bare = new Request(LOAD, { method: "POST", headers: { origin: ORIGIN }, body: null })
  expect((await fx.app.fetch(bare)).status).toBe(415)
  expect(
    (await load(fx.app, {}, { "content-type": "Application/JSON; charset=utf-8" })).res.status,
  ).toBe(200)
  expect(fx.calls.root).toBe(1)
})

test("a body over 64 KB is refused, declared or streamed", async () => {
  const fx = fixture()
  const big = JSON.stringify({ path: "/posts/42", pad: "x".repeat(70_000) })
  const declared = await fx.app.fetch(
    new Request(LOAD, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "content-length": "70100" },
      body: big,
    }),
  )
  expect(declared.status).toBe(413)
  const streamed = await fx.app.fetch(
    new Request(LOAD, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("x".repeat(4096)))
          c.close()
        },
      }),
    }),
  )
  expect(streamed.status).toBe(413)
  const malformed = await fx.app.fetch(
    new Request(LOAD, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "content-length": "1e3" },
      body: "{}",
    }),
  )
  expect(malformed.status).toBe(400)
  expect(fx.calls.root).toBeUndefined()
})

test("malformed bodies are refused before any app code runs", async () => {
  const hooks: string[] = []
  const fx = fixture({
    use: (app) =>
      app.onRequest((req) => {
        hooks.push(req.url)
      }),
  })
  const base = { path: "/posts/42", sid: SID, frame: "page", mode: "load" }
  const bodies: unknown[] = [
    "not json",
    "[]",
    "null",
    { ...base, sid: "short" },
    { ...base, sid: SID.toUpperCase() },
    { ...base, path: 42 },
    { ...base, frame: "modal" },
    { ...base, mode: "push" },
    { ...base, retain: "L:_layout" },
    { ...base, retain: Array.from({ length: 65 }, () => ROOT) },
    { ...base, retain: [42] },
    { ...base, retain: ["L:".padEnd(513, "x")] },
    { ...base, grants: ["a", "b", "c", "d"] },
    { ...base, grants: ["x".repeat(10_241)] },
  ]
  for (const body of bodies) {
    const res = await fx.app.fetch(
      new Request(LOAD, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    )
    expect({ body, status: res.status }).toEqual({ body, status: 400 })
  }
  const invalidUtf8 = await fx.app.fetch(
    new Request(LOAD, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    }),
  )
  expect(invalidUtf8.status).toBe(400)
  expect(hooks).toEqual([])
})

test("only a canonical same-origin path is loaded", async () => {
  const fx = fixture()
  const refused = [
    "",
    "posts/42",
    "//evil.test/posts/42",
    "/\\evil.test",
    "http://evil.test/posts/42",
    `${ORIGIN}/posts/42`,
    "/posts/../about",
    "/posts/./42",
    "/posts/42#top",
    "/posts/4\t2",
    "/posts/42 ",
    `/${"a".repeat(2048)}`,
  ]
  for (const path of refused) {
    const { res } = await load(fx.app, { path })
    expect({ path, status: res.status }).toEqual({ path, status: 400 })
  }
  expect((await load(fx.app, { path: "/posts/42?tab=comments" })).res.status).toBe(200)
  expect(fx.calls.root).toBe(1)
})

test("the endpoint answers only POST; other methods fall through to the app", async () => {
  const fx = fixture()
  const res = await fx.app.fetch(new Request(LOAD, { headers: { origin: ORIGIN } }))
  expect(res.status).toBe(404)
  const elsewhere = await fx.app.fetch(
    new Request(`${ORIGIN}/_nifra/live/other`, { method: "POST", headers: { origin: ORIGIN } }),
  )
  expect(elsewhere.status).not.toBe(200)
})

test("the load path is configurable", async () => {
  const fx = fixture({ live: { loadPath: "/live" } })
  const res = await fx.app.fetch(
    new Request(`${ORIGIN}/live?x=1`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: "user=alice" },
      body: JSON.stringify({ path: "/about", sid: SID, frame: "page", mode: "load" }),
    }),
  )
  const json: LiveJson = await res.json()
  expect(json.live?.grant).toBeDefined()
})

// --- The internal GET --------------------------------------------------------------------------

test("the internal GET carries exactly the headers of the router's data fetch for that path", async () => {
  const seen: Request[] = []
  const fx = fixture({
    use: (app) =>
      app.onRequest((req) => {
        seen.push(req)
      }),
  })
  await fx.app.fetch(
    new Request(`${ORIGIN}/posts/42`, { headers: { ...BROWSER, [DATA_HEADER]: "1" } }),
  )
  await load(
    fx.app,
    {},
    {
      connection: "keep-alive, x-hop",
      "x-hop": "secret",
      "keep-alive": "timeout=5",
      "proxy-connection": "keep-alive",
      te: "trailers",
      trailer: "x-sum",
      upgrade: "h2c",
      "content-encoding": "identity",
      [RETAIN_HEADER]: "0,1,2",
      [NAV_FROM_HEADER]: "/evil",
      "x-nifra-live": "1",
      "x-nifra-component": "1",
    },
  )
  expect(seen).toHaveLength(2)
  const entries = (req: Request) => [...req.headers.entries()].sort()
  const [router, internal] = seen
  if (router === undefined || internal === undefined)
    throw new Error("both requests reach the hook")
  expect(entries(internal)).toEqual(entries(router))
  expect(internal.method).toBe("GET")
  expect(internal.url).toBe(router.url)
})

test("every app hook sees the target GET exactly once, so a path rule covers live loads", async () => {
  const seen: string[] = []
  const fx = fixture({
    use: (app) =>
      app.onRequest((req) => {
        seen.push(`${req.method} ${new URL(req.url).pathname}`)
        if (new URL(req.url).pathname === "/about") {
          return new Response("forbidden", { status: 403 })
        }
        return undefined
      }),
  })
  const allowed = await load(fx.app)
  expect(allowed.res.status).toBe(200)
  const denied = await load(fx.app, { path: "/about" })
  expect(denied.res.status).toBe(403)
  expect(seen).toEqual(["GET /posts/42", "GET /about"])
  expect(fx.calls.about).toBeUndefined()
})

test("an app that authenticates by Authorization header works the same as a cookie app", async () => {
  const fx = fixture({
    live: {
      subject: (ctx) => ctx.request.headers.get("authorization")?.replace("Bearer ", "") ?? null,
    },
    use: (app) =>
      app.onRequest((req) =>
        new URL(req.url).pathname.startsWith("/posts") &&
        req.headers.get("authorization") !== "Bearer alice"
          ? new Response("unauthorized", { status: 401 })
          : undefined,
      ),
  })
  expect((await load(fx.app, {}, { cookie: "" })).res.status).toBe(401)
  const { res, json } = await load(fx.app, {}, { cookie: "", authorization: "Bearer alice" })
  expect(res.status).toBe(200)
  expect((await opened(json.live?.grant))?.sub).toBe("alice")
})

test("a hook that turns the load into a document request gets no grant", async () => {
  const fx = fixture({
    live: { maxConcurrentLoads: 1 },
    use: (app) =>
      app.onRequest((req) => {
        if (req.headers.get("x-doc") === null) return undefined
        const headers = new Headers(req.headers)
        headers.delete(DATA_HEADER)
        return new Request(req.url, { headers })
      }),
  })
  const doc = await load(fx.app, {}, { "x-doc": "1" })
  expect(doc.res.headers.get("content-type")).toContain("text/html")
  // Its slot was released.
  expect((await load(fx.app)).res.status).toBe(200)
})

// --- Admission ---------------------------------------------------------------------------------

const gated = () => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  return { gate, open, started, entered }
}

test("past maxConcurrentLoads the endpoint answers 503 with a 1-3 s Retry-After", async () => {
  const slow = gated()
  const fx = fixture({
    live: { maxConcurrentLoads: 1 },
    page: async () => {
      slow.entered()
      await slow.gate
      return { id: "42" }
    },
  })
  const first = load(fx.app)
  await slow.started
  const busy = await load(fx.app)
  expect(busy.res.status).toBe(503)
  expect(["1", "2", "3"]).toContain(busy.res.headers.get("retry-after") ?? "")
  expect(busy.res.headers.get("cache-control")).toBe("private, no-store")
  slow.open()
  expect((await first).res.status).toBe(200)
  expect((await load(fx.app)).res.status).toBe(200)
})

test("two loads admitted at the entry at once still hold only maxConcurrentLoads slots", async () => {
  const slow = gated()
  const fx = fixture({
    live: { maxConcurrentLoads: 1 },
    page: async () => {
      slow.entered()
      await slow.gate
      return { id: "42" }
    },
  })
  const both = Promise.all([load(fx.app), load(fx.app)])
  await slow.started
  slow.open()
  const statuses = (await both).map(({ res }) => res.status).sort()
  expect(statuses).toEqual([200, 503])
})

test("a load still reading its body or opening grants holds a slot at the entry", async () => {
  const fx = fixture({ live: { maxConcurrentLoads: 1 } })
  const stalled = gated()
  const body = JSON.stringify({ path: "/posts/42", sid: SID, frame: "page", mode: "load" })
  const slow = fx.app.fetch(
    new Request(LOAD, {
      method: "POST",
      headers: { ...BROWSER, origin: ORIGIN, "content-type": "application/json" },
      body: new ReadableStream({
        async pull(c) {
          stalled.entered()
          await stalled.gate
          c.enqueue(new TextEncoder().encode(body))
          c.close()
        },
      }),
    }),
  )
  await stalled.started
  expect((await load(fx.app)).res.status).toBe(503)
  stalled.open()
  expect((await slow).status).toBe(200)
  expect((await load(fx.app)).res.status).toBe(200)
})

test("a load that fails releases its slot", async () => {
  const fx = fixture({
    live: { maxConcurrentLoads: 1 },
    page: () => {
      throw new Error("boom")
    },
  })
  expect((await load(fx.app)).res.status).toBe(500)
  expect((await load(fx.app)).res.status).toBe(500)
})

test("a streamed load holds its slot until the body ends or is cancelled", async () => {
  const fx = fixture({
    live: { maxConcurrentLoads: 1 },
    page: (ctx) => {
      ctx.live("post:42")
      return { id: "42", later: defer(Promise.resolve("done")) }
    },
  })
  const streaming = await postLoad(fx.app, {
    path: "/posts/42",
    sid: SID,
    frame: "page",
    mode: "load",
  })
  expect(streaming.headers.get("content-type")).toContain("application/x-ndjson")
  expect((await load(fx.app)).res.status).toBe(503)
  const text = await streaming.text()
  expect(text).toContain('"live"')
  expect(text).toContain("done")
  const cancelled = await postLoad(fx.app, {
    path: "/posts/42",
    sid: SID,
    frame: "page",
    mode: "load",
  })
  expect(cancelled.status).toBe(200)
  await cancelled.body?.cancel()
  expect((await load(fx.app)).res.status).toBe(200)
})

// --- Configuration -----------------------------------------------------------------------------

test("live() checks its options at boot", () => {
  const subject = () => null
  expect(() => Reflect.apply(live, undefined, [{ secret: SECRET }])).toThrow(/subject/)
  expect(() => live({ secret: SECRET, subject, grantTtl: 30 })).toThrow(/grantTtl/)
  expect(() => live({ secret: SECRET, subject, grantTtl: 1.5 })).toThrow(/grantTtl/)
  expect(() => live({ secret: SECRET, subject, maxConcurrentLoads: 0 })).toThrow(
    /maxConcurrentLoads/,
  )
  expect(() => live({ secret: SECRET, subject, loadPath: "relative" })).toThrow(/loadPath/)
  expect(() => live({ secret: SECRET, subject, loadPath: "/x?y" })).toThrow(/loadPath/)
  expect(() => live({ secret: SECRET, subject, appId: "" })).toThrow(/appId/)
  expect(() => live({ secret: "short", subject })).toThrow(/32 bytes/)
  expect(() =>
    live({ secret: [SECRET, OLD_SECRET, "x".repeat(32), "y".repeat(32)], subject }),
  ).toThrow(/at most 3/)
})

test("production requires a secret; development makes one per process", async () => {
  const subject = () => null
  process.env.NODE_ENV = "production"
  expect(() => live({ subject })).toThrow(/required in production/)
  expect(() => live({ subject, secret: [] })).toThrow(/required in production/)
  process.env.NODE_ENV = "development"
  const runtime = live({ subject, secret: "" })
  await runtime.ready
  const fx = fixture({ runtime })
  expect((await load(fx.app)).json.live?.grant).toBeDefined()
})

test("two secrets sharing a secret id fail boot, and no live load is served", async () => {
  const runtime = live({
    subject: () => null,
    secret: ["live-secret-id-collision-fixture-14969", "live-secret-id-collision-fixture-53199"],
  })
  await expect(runtime.ready).rejects.toThrow(/share a secret id/)
  const fx = fixture({ runtime })
  const { res } = await load(fx.app)
  expect(res.status).toBe(500)
  expect(fx.calls.root).toBeUndefined()
})

test("live.subject must return a string or null", async () => {
  const fx = fixture({ live: { subject: () => JSON.parse("42") } })
  expect((await load(fx.app)).res.status).toBe(500)
})

// --- Zero cost for apps without live -----------------------------------------------------------

test("an app without live imports no live module", async () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const root = new URL("../src/", import.meta.url).pathname
  const seen = new Set<string>()
  const walk = async (file: string): Promise<void> => {
    if (seen.has(file)) return
    seen.add(file)
    const source = await Bun.file(file).text()
    for (const { path } of transpiler.scanImports(source)) {
      if (!path.startsWith(".")) continue
      await walk(new URL(path, `file://${file}`).pathname)
    }
  }
  await walk(`${root}index.ts`)
  const live = [...seen].filter((file) => file.startsWith(`${root}live`))
  expect(seen.size).toBeGreaterThan(20)
  expect(live).toEqual([])
  expect(seen.has(`${root}internal/live-contract.ts`)).toBe(true)
})
