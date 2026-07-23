import { expect, test } from "bun:test"
import { signValue } from "@nifrajs/core"
import {
  createWebApp,
  DRAFT_COOKIE,
  disableDraft,
  enableDraft,
  isDraftEnabled,
  type Manifest,
  MemoryCacheStore,
  previewEndpoint,
  type RenderAdapter,
  withISR,
} from "../src/index.ts"

const SECRET = "draft-secret-padded-to-at-least-32b"

// A fake `c.set` recording cookie writes/deletes — enough for enableDraft/disableDraft.
function fakeContext() {
  const set = {
    written: [] as Array<{
      name: string
      value: string
      options: Record<string, unknown> | undefined
    }>,
    deleted: [] as string[],
    cookie(name: string, value: string, options?: Record<string, unknown>) {
      set.written.push({ name, value, options })
    },
    deleteCookie(name: string) {
      set.deleted.push(name)
    },
  }
  return { set }
}

const cookieReq = (signed: string): Request =>
  new Request("http://x/", { headers: { cookie: `${DRAFT_COOKIE}=${signed}` } })

test("enableDraft sets a signed, HttpOnly, SameSite=Lax cookie that isDraftEnabled accepts", async () => {
  const c = fakeContext()
  await enableDraft(c, SECRET, { maxAgeSeconds: 60 })
  const written = c.set.written[0]
  expect(written?.name).toBe(DRAFT_COOKIE)
  expect(written?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 })
  // The value round-trips: a request carrying it verifies under the same secret.
  expect(await isDraftEnabled(cookieReq(written?.value ?? ""), SECRET)).toBe(true)
})

test("isDraftEnabled rejects a missing, forged, or wrong-secret cookie (constant-time verify)", async () => {
  const signed = await signValue("1", SECRET)
  expect(await isDraftEnabled(cookieReq(signed), SECRET)).toBe(true)
  expect(await isDraftEnabled(new Request("http://x/"), SECRET)).toBe(false) // no cookie
  expect(await isDraftEnabled(cookieReq("1.not-a-real-signature"), SECRET)).toBe(false) // forged
  expect(await isDraftEnabled(cookieReq(signed), "a-different-secret-padded-32bytes!")).toBe(false) // wrong secret
})

test("disableDraft clears the draft cookie", () => {
  const c = fakeContext()
  disableDraft(c)
  expect(c.set.deleted).toEqual([DRAFT_COOKIE])
})

// --- createWebApp: ctx.draft on loaders ---

const stub: RenderAdapter = { renderToStream: () => new ReadableStream(), hydrationHead: () => "" }

const draftManifest = (): Manifest => ({
  routes: [
    {
      id: "page",
      pattern: "/page",
      layoutIds: [],
      file: "page.tsx",
      load: async () => ({ default: "page", loader: (ctx) => ({ draft: ctx.draft }) }),
    },
  ],
  layouts: {},
  notFound: { file: "_404.tsx", load: async () => ({ default: "not-found" }) },
})

// Data-mode GET (x-nifra-data) returns the loader result as JSON before any render — lets us read ctx.draft.
const dataReq = (cookie?: string): Request =>
  new Request("http://x/page", {
    headers: { "x-nifra-data": "1", ...(cookie === undefined ? {} : { cookie }) },
  })

test("createWebApp sets ctx.draft=true only for a valid cookie when draftSecret is configured", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: draftManifest(),
    clientEntry: "/c.js",
    draftSecret: SECRET,
  })
  const signed = await signValue("1", SECRET)
  expect(await (await app.fetch(dataReq(`${DRAFT_COOKIE}=${signed}`))).json()).toEqual({
    draft: true,
  })
  expect(await (await app.fetch(dataReq())).json()).toEqual({ draft: false }) // no cookie
  expect(await (await app.fetch(dataReq(`${DRAFT_COOKIE}=1.forged`))).json()).toEqual({
    draft: false,
  })
})

test("createWebApp leaves ctx.draft=false when no draftSecret is set (even with a cookie)", async () => {
  const app = createWebApp({ adapter: stub, manifest: draftManifest(), clientEntry: "/c.js" })
  const signed = await signValue("1", SECRET)
  expect(await (await app.fetch(dataReq(`${DRAFT_COOKIE}=${signed}`))).json()).toEqual({
    draft: false,
  })
})

// --- withISR: editors bypass the cache ---

test("withISR bypasses the cache for a valid draft request (fresh render, never cached)", async () => {
  let fetches = 0
  const app = {
    fetch: () => {
      fetches += 1
      return new Response("<html>fresh</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    },
  }
  const store = new MemoryCacheStore()
  await store.set("http://x/", {
    body: "<html>cached</html>",
    status: 200,
    headers: { "content-type": "text/html" },
    storedAt: 1000,
    revalidate: 60_000,
  })
  const handler = withISR(app, { store, revalidate: 60, now: () => 1000, draftSecret: SECRET })

  // A normal visitor is served the fresh cache hit (not the app).
  expect(await (await handler(new Request("http://x/"))).text()).toContain("cached")
  expect(fetches).toBe(0)

  // An editor (valid draft cookie) bypasses the cache → the app renders fresh.
  const signed = await signValue("1", SECRET)
  const res = await handler(
    new Request("http://x/", { headers: { cookie: `${DRAFT_COOKIE}=${signed}` } }),
  )
  expect(await res.text()).toContain("fresh")
  expect(fetches).toBe(1)
  // And the draft render was NOT written to the public cache.
  expect((await store.get("http://x/"))?.body).toContain("cached")
})

const PREVIEW_TOKEN = "preview-token-padded-to-at-least-32b"

const preview = () => previewEndpoint({ secret: PREVIEW_TOKEN, draftSecret: SECRET })

test("previewEndpoint authorizes, sets the signed cookie, and redirects", async () => {
  const res = await preview()(
    new Request(`http://x/api/preview?token=${PREVIEW_TOKEN}&to=/posts/hello`),
  )

  expect(res.status).toBe(302)
  expect(res.headers.get("location")).toBe("/posts/hello")
  // A per-editor response carrying a Set-Cookie must never be replayed to a visitor by a shared cache.
  expect(res.headers.get("cache-control")).toBe("no-store")

  const cookie = res.headers.get("set-cookie") ?? ""
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("SameSite=Lax")
  // `serializeCookie` is pure and applies no security defaults, so `Secure` only appears if the
  // endpoint passes it explicitly — the exact attribute a direct-serialize path silently drops.
  expect(cookie).toContain("Secure")

  // The cookie it issues is one `isDraftEnabled` actually accepts (not merely present-and-signed).
  const value = decodeURIComponent(cookie.slice(`${DRAFT_COOKIE}=`.length).split(";")[0] as string)
  expect(
    await isDraftEnabled(
      new Request("http://x/", { headers: { cookie: `${DRAFT_COOKIE}=${value}` } }),
      SECRET,
    ),
  ).toBe(true)
})

test("previewEndpoint rejects a wrong or missing token without setting a cookie", async () => {
  for (const url of [
    "http://x/api/preview",
    "http://x/api/preview?token=",
    "http://x/api/preview?token=wrong",
    // Same length as the real token, differing only in the last byte: the case an early-exit
    // compare would answer faster than a wrong first byte.
    `http://x/api/preview?token=${PREVIEW_TOKEN.slice(0, -1)}X`,
  ]) {
    const res = await preview()(new Request(url))
    expect(res.status).toBe(401)
    expect(res.headers.get("set-cookie")).toBeNull()
  }
})

test("previewEndpoint refuses an off-site redirect target", async () => {
  // Each of these starts with "/" — the check people actually write — yet navigates off-site.
  for (const to of [
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "http://evil.com",
    "evil.com",
  ]) {
    const res = await preview()(
      new Request(`http://x/api/preview?token=${PREVIEW_TOKEN}&to=${encodeURIComponent(to)}`),
    )
    expect(res.status).toBe(400)
    expect(res.headers.get("set-cookie")).toBeNull()
  }

  // A newline would split the Location header; refused rather than left to the runtime.
  const split = await preview()(
    new Request(
      `http://x/api/preview?token=${PREVIEW_TOKEN}&to=${encodeURIComponent("/ok\r\nX: 1")}`,
    ),
  )
  expect(split.status).toBe(400)
})

test("previewEndpoint falls back when no destination is given, and validates the fallback at construction", async () => {
  const res = await preview()(new Request(`http://x/api/preview?token=${PREVIEW_TOKEN}`))
  expect(res.status).toBe(302)
  expect(res.headers.get("location")).toBe("/")

  const custom = previewEndpoint({
    secret: PREVIEW_TOKEN,
    draftSecret: SECRET,
    fallbackPath: "/admin",
  })
  expect(
    (await custom(new Request(`http://x/p?token=${PREVIEW_TOKEN}`))).headers.get("location"),
  ).toBe("/admin")

  // A misconfigured fallback is a deploy-time mistake: it throws at construction rather than
  // surfacing as a rare 400 on the one request that omits `?to=`.
  expect(() =>
    previewEndpoint({ secret: PREVIEW_TOKEN, draftSecret: SECRET, fallbackPath: "//evil.com" }),
  ).toThrow(/site-relative/)
})

test("previewEndpoint honours custom param names and cookie options", async () => {
  const handler = previewEndpoint({
    secret: PREVIEW_TOKEN,
    draftSecret: SECRET,
    tokenParam: "k",
    redirectParam: "next",
    cookie: { maxAgeSeconds: 60, path: "/admin", secure: false },
  })
  const res = await handler(new Request(`http://x/p?k=${PREVIEW_TOKEN}&next=/admin/posts`))

  expect(res.status).toBe(302)
  expect(res.headers.get("location")).toBe("/admin/posts")
  const cookie = res.headers.get("set-cookie") ?? ""
  expect(cookie).toContain("Max-Age=60")
  expect(cookie).toContain("Path=/admin")
  // Opt-out for local http:// dev is respected rather than forced.
  expect(cookie).not.toContain("Secure")

  // The default param names no longer authorize once overridden.
  expect((await handler(new Request(`http://x/p?token=${PREVIEW_TOKEN}`))).status).toBe(401)
})
