import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEV_FEED_PATHS, DEV_REQUEST_ID_HEADER } from "../src/dev-feed.ts"
import { createDevSession, type DevSession } from "../src/dev-session.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

interface Running {
  readonly root: string
  readonly session: DevSession
  readonly origin: string
  /** Static files the server answers before the app. */
  readonly files: Map<string, string>
}

/** A dev session behind a real socket, serving pages the way the Bun pipeline does. */
const start = (
  page = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>hi</body></html>',
  pageHeaders: Record<string, string> = {},
  indicator = true,
): Running => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nifra-dev-ingest-")))
  const session = createDevSession({ root, pipeline: "bun", record: false, indicator })
  const files = new Map<string, string>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const agent = await session.handle(request)
      if (agent !== undefined) return agent
      const file = files.get(new URL(request.url).pathname)
      if (file !== undefined)
        return new Response(file, { headers: { "content-type": "text/javascript" } })
      return session.track(request, async () =>
        session.decoratePage(
          request,
          new Response(page, {
            headers: { "content-type": "text/html; charset=utf-8", ...pageHeaders },
          }),
        ),
      )
    },
  })
  session.listening(server.port ?? 0)
  cleanups.push(() => {
    server.stop(true)
    session.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, session, origin: `http://127.0.0.1:${server.port}`, files }
}

/** The page token, the way the browser gets it: from the script in the page. */
const pageTokenOf = async (app: Running): Promise<{ token: string; requestId: string }> => {
  const response = await fetch(`${app.origin}/`)
  const html = await response.text()
  const token = /"t":"([^"]+)"/.exec(html)?.[1]
  if (token === undefined) throw new Error("no dev script in the page")
  return { token, requestId: response.headers.get(DEV_REQUEST_ID_HEADER) ?? "" }
}

const post = (
  app: Running,
  body: unknown,
  headers: Record<string, string> = { origin: app.origin },
): Promise<Response> =>
  fetch(`${app.origin}${DEV_FEED_PATHS.clientEvent}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

test("pages carry the script first in <head>; its batches land as browser entries tagged with the page's request", async () => {
  const app = start()
  const response = await fetch(`${app.origin}/`)
  const html = await response.text()
  expect(
    html.startsWith(`<!doctype html><html><head><meta charset="utf-8"><script data-nifra-dev>`),
  ).toBe(true)
  const { token, requestId } = await pageTokenOf(app)

  const sent = await post(app, {
    token,
    events: [
      { kind: "console", level: "warn", message: "low stock", page: "/", requestId },
      {
        kind: "error",
        name: "TypeError",
        message: "cart.items is undefined",
        stack: "TypeError: cart.items is undefined\n    at https://cdn.example.com/x.js:1:2",
        page: "/",
        requestId,
      },
      {
        kind: "rejection",
        name: "UnhandledRejection",
        message: '{"code":42}',
        stack: "",
        page: "/cart",
      },
      { kind: "resource", tag: "script", url: "/missing.js", page: "/" },
    ],
  })
  // The page gets back the errors it just reported, for its in-page indicator.
  expect(sent.status).toBe(200)
  const answered: { issues: { code: string; category: string }[] } = await sent.json()
  expect(answered.issues.map((issue) => [issue.code, issue.category])).toEqual([
    ["NIFRA_UNHANDLED", "browser"],
    ["NIFRA_UNHANDLED", "browser"],
    ["NIFRA_UNHANDLED", "browser"],
  ])

  const errors = app.session.feed.errors().errors
  expect(errors.map((entry) => [entry.category, entry.source, entry.diagnostic.name])).toEqual([
    ["browser", "browser", "TypeError"],
    ["browser", "browser", "UnhandledRejection"],
    ["browser", "browser", "ResourceError"],
  ])
  expect(errors[0]).toMatchObject({ page: "/", requestId })
  expect(errors[0]?.diagnostic.frames[0]?.raw).toContain("cdn.example.com")
  expect(app.session.feed.requests({ requestId }).requests[0]?.errorIds).toEqual([
    errors[0]?.id ?? "",
  ])

  const logs = app.session.feed.logs({ source: "browser" }).logs
  expect(logs.map((line) => [line.level, line.message])).toEqual([
    ["warn", "low stock"],
    ["error", "Uncaught TypeError: cart.items is undefined"],
    ["error", 'Uncaught (in promise) UnhandledRejection: {"code":42}'],
    ["error", "ResourceError: failed to load <script> /missing.js"],
  ])
})

test("hydration mismatches are their own category, whether thrown or logged", async () => {
  const app = start()
  const { token } = await pageTokenOf(app)
  const sent = await post(app, {
    token,
    events: [
      {
        kind: "error",
        name: "Error",
        message: "Hydration failed because the server rendered HTML didn't match the client.",
        stack: "",
        page: "/",
      },
      {
        kind: "console",
        level: "warn",
        message: "[Vue warn]: Hydration node mismatch:",
        page: "/",
      },
      {
        kind: "console",
        level: "error",
        message: 'Warning: Text content did not match. Server: "1" Client: "2"',
        page: "/",
      },
    ],
  })
  const hydration = app.session.feed.errors({ categories: ["hydration"] }).errors
  expect(hydration).toHaveLength(3)
  expect(hydration.every((entry) => entry.diagnostic.code === "NIFRA_HYDRATION_MISMATCH")).toBe(
    true,
  )
  // The indicator gets each with the recognised fix and a prompt naming its entry.
  const {
    issues,
  }: { issues: { id: string; category: string; fix?: string; prompts: { prompt: string }[] }[] } =
    await sent.json()
  expect(issues.map((issue) => issue.category)).toEqual(["hydration", "hydration", "hydration"])
  expect(issues[0]?.fix).toContain("nifra_hydrate")
  expect(issues[0]?.prompts[0]?.prompt).toContain("Reload the page named under Request")
})

test("console.error(err) is an error entry too: frameworks report caught errors that way", async () => {
  const app = start()
  const { token } = await pageTokenOf(app)
  await post(app, {
    token,
    events: [
      {
        kind: "console",
        level: "error",
        message: "The above error occurred in <Cart>: Error: render failed",
        error: {
          name: "Error",
          message: "render failed",
          stack: "Error: render failed\n    at Cart (https://cdn.example.com/a.js:1:1)",
        },
        page: "/cart",
      },
    ],
  })
  expect(app.session.feed.errors().errors.map((e) => [e.category, e.diagnostic.message])).toEqual([
    ["browser", "Error: render failed"],
  ])
  expect(app.session.feed.logs({ source: "browser" }).logs).toHaveLength(1)
})

test("a browser stack is source-mapped through the server's own scripts", async () => {
  const app = start()
  mkdirSync(join(app.root, "routes"))
  const source = join(app.root, "routes", "cart.ts")
  writeFileSync(
    source,
    'export function total(): number {\n  throw new RangeError("negative total")\n}\n',
  )
  const built = await Bun.build({
    entrypoints: [source],
    sourcemap: "linked",
    outdir: join(app.root, "out"),
  })
  for (const output of built.outputs)
    app.files.set(`/out/${output.path.split("/").at(-1)}`, await output.text())
  const script = [...app.files].find(([path]) => path.endsWith(".js"))
  const lines = (script?.[1] ?? "").split("\n")
  const line = lines.findIndex((text) => text.includes("throw new RangeError"))
  const column = (lines[line]?.indexOf("throw") ?? 0) + 1
  const { token } = await pageTokenOf(app)
  await post(app, {
    token,
    events: [
      {
        kind: "error",
        name: "RangeError",
        message: "negative total",
        // Safari's shape: frames only, `name@url:line:col`, on the page's own host name.
        stack: `total@http://localhost:${new URL(app.origin).port}${script?.[0]}:${line + 1}:${column}`,
        page: "/cart",
      },
    ],
  })
  const [entry] = app.session.feed.errors().errors
  expect(entry?.diagnostic.frames[0]).toMatchObject({ file: source, line: 2 })
  expect(
    entry?.diagnostic.codeframe?.lines.some((l) => l.caret && l.text.includes("negative total")),
  ).toBe(true)
})

test("ingest refuses other origins, a wrong token, bad shapes, big bodies and floods", async () => {
  const app = start()
  const { token } = await pageTokenOf(app)
  const one = { token, events: [{ kind: "console", level: "log", message: "x", page: "/" }] }

  expect((await post(app, one, {})).status).toBe(403) // no Origin
  expect((await post(app, one, { origin: "https://evil.example" })).status).toBe(403)
  expect(
    (await post(app, one, { origin: app.origin, "sec-fetch-site": "cross-site" })).status,
  ).toBe(403)
  expect((await post(app, { ...one, token: "x".repeat(43) })).status).toBe(401)
  expect((await post(app, "{not json")).status).toBe(400)
  expect((await post(app, { token, events: "nope" })).status).toBe(400)
  expect(
    (await post(app, JSON.stringify({ token, events: [], pad: "x".repeat(70_000) }))).status,
  ).toBe(413)
  expect((await fetch(`${app.origin}${DEV_FEED_PATHS.clientEvent}`)).status).toBe(405)
  // DNS rebinding: a foreign Host never reaches the handler.
  const rebound = await app.session.handle(
    new Request(`${app.origin}${DEV_FEED_PATHS.clientEvent}`, {
      method: "POST",
      headers: { host: "evil.example", origin: "http://evil.example" },
      body: JSON.stringify(one),
    }),
  )
  expect(rebound?.status).toBe(403)

  const burst = {
    token,
    events: Array.from({ length: 50 }, (_, i) => ({
      kind: "console",
      level: "log",
      message: `m${i}`,
      page: "/",
    })),
  }
  const statuses: number[] = []
  for (let i = 0; i < 8; i++) statuses.push((await post(app, burst)).status)
  expect(statuses).toContain(429)
  expect(app.session.feed.logs({ grep: "dropping the excess" }).logs).toHaveLength(1)
})

test("a page whose CSP forbids scripts gets no script; a nonce page gets the script by hash", async () => {
  const blocked = start(undefined, { "content-security-policy": "script-src 'none'" })
  expect(await (await fetch(`${blocked.origin}/`)).text()).not.toContain("data-nifra-dev")

  const strict = start(undefined, { "content-security-policy": "script-src 'nonce-abc'" })
  const response = await fetch(`${strict.origin}/`)
  expect(await response.text()).toContain("data-nifra-dev")
  expect(response.headers.get("content-security-policy")).toBe(
    `script-src 'nonce-abc' ${/'sha256-[A-Za-z0-9+/=]+'/.exec(response.headers.get("content-security-policy") ?? "")?.[0]} ${strict.origin}${DEV_FEED_PATHS.indicator}`,
  )

  // 'strict-dynamic' ignores URL sources and trusts what the trusted script loads, so none is added.
  const dynamic = start(undefined, {
    "content-security-policy": "script-src 'nonce-abc' 'strict-dynamic'",
  })
  const dynamicPolicy = (await fetch(`${dynamic.origin}/`)).headers.get("content-security-policy")
  expect(dynamicPolicy).not.toContain(DEV_FEED_PATHS.indicator)
})

test("the indicator: own errors back, logs alone get 204, and the module is served", async () => {
  const app = start()
  const { token } = await pageTokenOf(app)
  const log = await post(app, {
    token,
    events: [{ kind: "console", level: "log", message: "hi", page: "/" }],
  })
  expect(log.status).toBe(204)

  const first = await post(app, {
    token,
    events: [{ kind: "error", name: "Error", message: "first", stack: "", page: "/" }],
  })
  const second = await post(app, {
    token,
    events: [{ kind: "error", name: "Error", message: "second", stack: "", page: "/" }],
  })
  type Answer = {
    issues: { id: string; message: string; prompts: { label: string; prompt: string }[] }[]
  }
  const a: Answer = await first.json()
  const b: Answer = await second.json()
  expect(a?.issues.map((issue) => issue.message)).toEqual(["Error: first"])
  expect(b?.issues.map((issue) => issue.message)).toEqual(["Error: second"])
  const prompt = b?.issues[0]?.prompts[0]?.prompt ?? ""
  expect(prompt).toContain(`entry ${b?.issues[0]?.id} does not come back`)
  expect(prompt).not.toContain(app.root)

  const module = await fetch(`${app.origin}${DEV_FEED_PATHS.indicator}`)
  expect(module.status).toBe(200)
  expect(module.headers.get("content-type")).toContain("text/javascript")
  expect(await module.text()).toContain("__nifraDevClient")
})

test("with the indicator off, errors get 204, pages do not name it, and it is not served", async () => {
  const app = start(undefined, { "content-security-policy": "script-src 'nonce-abc'" }, false)
  const page = await fetch(`${app.origin}/`)
  expect(await page.text()).not.toContain('"i":')
  expect(page.headers.get("content-security-policy")).not.toContain(DEV_FEED_PATHS.indicator)
  const { token } = await pageTokenOf(app)
  const sent = await post(app, {
    token,
    events: [{ kind: "error", name: "Error", message: "x", stack: "", page: "/" }],
  })
  expect(sent.status).toBe(204)
  expect((await fetch(`${app.origin}${DEV_FEED_PATHS.indicator}`)).status).toBe(404)
})

test("the issues a page gets back, prompts included, carry env secrets redacted", async () => {
  const secret = "zyxwvutsrqponmlkjihgfedcba-9876543210"
  process.env.NIFRA_TEST_INGEST_SECRET = secret
  let app: Running
  try {
    app = start()
  } finally {
    delete process.env.NIFRA_TEST_INGEST_SECRET
  }
  const { token } = await pageTokenOf(app)
  const res = await post(app, {
    token,
    events: [{ kind: "error", name: "Error", message: `leaked ${secret}`, stack: "", page: "/" }],
  })
  const text = await res.text()
  expect(res.status).toBe(200)
  expect(text).not.toContain(secret)
  expect(text).toContain("[redacted:NIFRA_TEST_INGEST_SECRET]")
})
