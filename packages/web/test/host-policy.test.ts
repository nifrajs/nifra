import { expect, test } from "bun:test"
import { connect } from "node:net"
import { serve } from "@nifrajs/node"
import {
  createHostPolicy,
  createWebApp,
  type HostPolicyRule,
  isHostPolicy,
  type RenderAdapter,
} from "../src/index.ts"
import { buildManifest } from "../src/manifest.ts"

const OWN_HOSTS = new Set(["app.test", "localhost"])
const partner = createHostPolicy({
  rules: [
    {
      hosts: (host) => !OWN_HOSTS.has(host),
      pages: ["/", "/p/:id", "/share/*"],
      paths: ["/api/items/:id"],
    },
  ],
})
const assets = new Set(["/assets/entry-abc.js", "/assets/app-def.css", "/sw.js"])

test("a restricted host gets its pages, its API paths and exactly the build's files", () => {
  for (const path of [
    "/",
    "/p/42",
    "/share/a/b",
    "/api/items/7",
    "/assets/entry-abc.js",
    "/sw.js",
  ]) {
    expect(partner.allows("partner.example", path, assets)).toBe(true)
  }
  for (const path of [
    "/login",
    "/p",
    "/p/1/edit",
    "/api/admin",
    "/assets/other.js",
    "/robots.txt",
  ]) {
    expect(partner.allows("partner.example", path, assets)).toBe(false)
  }
})

test("a host no rule names is not restricted", () => {
  expect(partner.allows("app.test", "/login", assets)).toBe(true)
  // Port and case do not make a host someone else's.
  expect(partner.allows("APP.test:8443", "/login", assets)).toBe(true)
})

test("without the build's file set the token matches nothing, and buildAssets: false opts out", () => {
  expect(partner.allows("partner.example", "/assets/entry-abc.js")).toBe(false)
  const strict = createHostPolicy({
    rules: [{ hosts: ["partner.example"], pages: ["/"], buildAssets: false, paths: ["/sw.js"] }],
  })
  expect(strict.allows("partner.example", "/assets/entry-abc.js", assets)).toBe(false)
  expect(strict.allows("partner.example", "/sw.js", assets)).toBe(true)
  expect(strict.allows("pArtner.example:443", "/", assets)).toBe(true)
})

test("a fully qualified host name with a trailing dot is the same host", () => {
  const listed = createHostPolicy({ rules: [{ hosts: ["partner.example"], pages: ["/"] }] })
  for (const host of ["partner.example.", "partner.example.:443", "PARTNER.example.."]) {
    expect(listed.allows(host, "/", assets)).toBe(true)
    expect(listed.allows(host, "/login", assets)).toBe(false)
  }
  // An own host spelled with the dot stays unrestricted under "every host that is not ours".
  expect(partner.allows("app.test.", "/login", assets)).toBe(true)
  expect(partner.allows("[::1]:443", "/login", assets)).toBe(false)
})

test("check reads the Host header, answers a bare 404 by default and a custom refusal when given", async () => {
  const refused = partner.check(new Request("http://partner.example/login"), assets)
  expect(refused?.status).toBe(404)
  expect(refused?.headers.get("cache-control")).toBe("no-store")
  expect(
    partner.check(new Request("http://partner.example/login", { headers: { host: "app.test" } })),
  ).toBeUndefined()
  const custom = createHostPolicy({
    rules: [{ hosts: ["partner.example"], pages: ["/"] }],
    refuse: ({ host, pathname }) => new Response(`${host} ${pathname}`, { status: 410 }),
  })
  const response = custom.check(new Request("http://partner.example/login?x=1"))
  expect(response?.status).toBe(410)
  expect(await response?.text()).toBe("partner.example /login")
})

test("a malformed rule is refused when the policy is made", () => {
  const unchecked = (rule: unknown) => () =>
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: malformed rules on purpose; the runtime refusal is what this checks.
    createHostPolicy({ rules: [rule as HostPolicyRule] })
  expect(unchecked({ hosts: "partner.example", pages: [] })).toThrow(
    /hosts must be a list of host names or a predicate/,
  )
  expect(() => createHostPolicy({ rules: [{ hosts: ["a.test"], pages: ["p/:id"] }] })).toThrow(
    /route patterns starting with "\/"/,
  )
  expect(unchecked({ hosts: ["a.test"] })).toThrow(/pages must list the page routes/)
  expect(isHostPolicy(partner)).toBe(true)
  expect(isHostPolicy({ allows: () => true, check: () => undefined })).toBe(false)
})

const adapter: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<p>page</p>"))
        controller.close()
      },
    }),
  hydrationHead: () => "",
}
const page = { default: () => null }
const manifest = buildManifest(
  ["index.tsx", "login.tsx", "p/[id].tsx"],
  () => () => Promise.resolve(page),
)

test("createWebApp runs the policy before its use() middleware, mounts and pages", async () => {
  const seen: string[] = []
  const app = createWebApp({
    adapter,
    manifest,
    clientEntry: "/assets/entry-abc.js",
    hostPolicy: partner,
    buildAssets: assets,
    use: (inner) => {
      inner.onRequest((request) => {
        seen.push(new URL(request.url).pathname)
        return undefined
      })
    },
    mounts: [{ path: "/auth", app: { fetch: () => new Response("auth") } }],
  })
  const on = (host: string, path: string) =>
    app.fetch(new Request(`http://${host}${path}`, { headers: { host } }))

  expect((await on("partner.example", "/p/9")).status).toBe(200)
  expect((await on("partner.example", "/login")).status).toBe(404)
  expect((await on("partner.example", "/auth/session")).status).toBe(404)
  expect((await on("app.test", "/login")).status).toBe(200)
  expect(await (await on("app.test", "/auth/session")).text()).toBe("auth")
  // The refused requests never reached the app's own middleware.
  expect(seen).toEqual(["/p/9", "/login", "/auth/session"])
})

test("createWebApp refuses a hostPolicy that createHostPolicy did not make", () => {
  expect(() =>
    createWebApp({
      adapter,
      manifest,
      clientEntry: "",
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a look-alike policy on purpose; the runtime refusal is what this checks.
      hostPolicy: { rules: [], allows: () => true } as never,
    }),
  ).toThrow(/hostPolicy` must come from createHostPolicy/)
})

/** The status line's code for one request sent exactly as written, dot segments included. */
function rawStatus(port: number, target: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    let head = ""
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1")
      const end = head.indexOf("\r\n")
      if (end !== -1) {
        socket.destroy()
        resolve(Number(head.slice(9, 12)))
      }
    })
    socket.on("error", reject)
  })
}

test("on Node a dot-segment target is judged by the path it routes to, not as sent", async () => {
  const app = createWebApp({
    adapter,
    manifest: buildManifest(
      ["index.tsx", "login.tsx", "share/[...rest].tsx"],
      () => () => Promise.resolve(page),
    ),
    clientEntry: "/assets/entry-abc.js",
    hostPolicy: partner,
  })
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    expect(await rawStatus(running.port, "/share/a", "partner.example")).toBe(200)
    // Sent as `/share/...`, which the policy allows, but it routes to the sign-in page.
    expect(await rawStatus(running.port, "/share/../login", "partner.example")).toBe(404)
    expect(await rawStatus(running.port, "/share/%2e%2e/login", "partner.example")).toBe(404)
    expect(await rawStatus(running.port, "/share/..\\login", "partner.example")).toBe(404)
    expect(await rawStatus(running.port, "/share/../login", "app.test")).toBe(200)
    expect(await rawStatus(running.port, "/share/a?next=/login#x", "partner.example")).toBe(200)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})
