import { expect, test } from "bun:test"
import { createWebApp, type Manifest, type RenderAdapter, type RouteModule } from "../src/index.ts"
import { DATA_HEADER } from "../src/router.ts"

const stub: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("<p>page</p>"))
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const appWith = (counts: { action: number }, extra: Partial<RouteModule> = {}) => {
  const page: RouteModule = {
    default: "page",
    action: () => {
      counts.action += 1
      return { ok: true }
    },
    ...extra,
  }
  const manifest: Manifest = {
    routes: [
      {
        id: "settings",
        pattern: "/settings",
        layoutIds: [],
        file: "settings.tsx",
        load: async () => page,
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  return createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
}

const post = (url: string, headers: Record<string, string>) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: "email=a%40b.example",
  })

test("a cross-site POST to an action is refused before the action runs", async () => {
  const counts = { action: 0 }
  const app = appWith(counts)
  const form = await app.fetch(
    post("https://bank.example/settings", { origin: "https://evil.example" }),
  )
  expect(form.status).toBe(403)
  expect(form.headers.get("cache-control")).toBe("private, no-store")
  const data = await app.fetch(
    post("https://bank.example/settings", { origin: "https://evil.example", [DATA_HEADER]: "1" }),
  )
  expect(data.status).toBe(403)
  expect(await data.json()).toEqual({ ok: false, error: "forbidden_origin" })
  const opaque = await app.fetch(post("https://bank.example/settings", { origin: "null" }))
  expect(opaque.status).toBe(403)
  expect(counts.action).toBe(0)
})

test("a same-origin POST, one behind a TLS-terminating proxy, and one without Origin run the action", async () => {
  const counts = { action: 0 }
  const app = appWith(counts)
  for (const request of [
    post("https://bank.example/settings", { origin: "https://bank.example" }),
    post("http://bank.example/settings", { origin: "https://bank.example" }),
    post("https://bank.example/settings", {}),
  ]) {
    expect((await app.fetch(request)).status).toBe(200)
  }
  expect(counts.action).toBe(3)
})

test("a route's allowedOrigins replaces the same-origin default", async () => {
  const listed = { action: 0 }
  const list = appWith(listed, { allowedOrigins: ["https://idp.example"] })
  const statuses = []
  for (const headers of [
    { origin: "https://idp.example" },
    { origin: "https://evil.example" },
    {},
  ]) {
    statuses.push((await list.fetch(post("https://app.example/settings", headers))).status)
  }
  expect(statuses).toEqual([200, 403, 403])
  expect(listed.action).toBe(1)

  const seen: Array<string | null> = []
  const decided = { action: 0 }
  const fn = appWith(decided, {
    allowedOrigins: (origin) => {
      seen.push(origin)
      return origin === null
    },
  })
  expect((await fn.fetch(post("https://app.example/settings", {}))).status).toBe(200)
  expect(
    (await fn.fetch(post("https://app.example/settings", { origin: "https://app.example" })))
      .status,
  ).toBe(403)
  expect(seen).toEqual([null, "https://app.example"])
  expect(decided.action).toBe(1)
})
