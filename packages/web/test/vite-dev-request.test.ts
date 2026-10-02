import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEV_FEED_PATHS,
  DEV_REQUEST_ID_HEADER,
  DEV_TOKEN_HEADER,
  readDevServerRecord,
} from "../src/dev-feed.ts"
import type { DevAppHooks } from "../src/dev-session.ts"
import { createViteDevServer, LAST_ERROR_PATH, type ViteDevServer } from "../src/vite.ts"

/**
 * What the Vite dev server does with a REQUEST, as opposed to with a file change.
 *
 * The dev server bridges Node's `http` to the app's `fetch`, and the bridge is where dev-only bugs
 * live: a POST whose body never arrives, or a thrown loader that returns a blank page instead of the
 * overlay that says what broke. Both are invisible to a route-discovery test, which is all this file's
 * sibling covers - it never sends a body and never throws.
 */

/** A JSON body, typed by the caller (`json()` is untyped). */
const readJson = async <T>(response: Response): Promise<T> => response.json()

const TMP_BASE = `${import.meta.dir}/.tmp-vite-dev-request-`
let root: string
let routesDir: string
let server: ViteDevServer | undefined

beforeEach(() => {
  root = mkdtempSync(TMP_BASE)
  routesDir = join(root, "routes")
  mkdirSync(routesDir)
  writeFileSync(join(routesDir, "index.tsx"), "export default function Index() { return null }\n")
  writeFileSync(join(root, "client.ts"), "export function mountRouter() {}\n")
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

const start = async (
  fetchImpl: (request: Request, dev: DevAppHooks) => Response | Promise<Response>,
  plugins: readonly unknown[] = [],
): Promise<string> => {
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    createApp: (_entry, _load, dev) => ({ fetch: (request) => fetchImpl(request, dev) }),
    plugins,
  })
  return `http://127.0.0.1:${server.port}`
}

test("a POST body reaches the app, byte for byte", async () => {
  // Node streams a request body in chunks; the bridge has to collect them before handing over a
  // `Request`. Dropping it makes every form post and API call in dev silently receive nothing, which
  // looks like a validation bug in the app rather than a dev-server one.
  const origin = await start(async (request) => {
    const raw = new Uint8Array(await request.arrayBuffer())
    return Response.json({
      method: request.method,
      bytes: raw.byteLength,
      text: new TextDecoder().decode(raw),
    })
  })

  const body = JSON.stringify({ hello: "wörld 🎉", nested: { n: 1 } })
  const res = await fetch(`${origin}/api/thing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    method: "POST",
    bytes: new TextEncoder().encode(body).byteLength,
    text: body,
  })
})

test("a GET is not made to wait on a body that will never come", async () => {
  const origin = await start(async (request) =>
    Response.json({ had: (await request.text()).length }),
  )
  const res = await fetch(`${origin}/`)
  expect(await res.json()).toEqual({ had: 0 })
})

test("a throwing app renders the dev overlay, not a blank 500", async () => {
  // The overlay is the whole point of the dev pipeline's error path: it names the failure. A bare 500
  // sends the developer to the terminal to guess.
  const origin = await start(() => {
    throw new Error("loader exploded in dev")
  })
  const res = await fetch(`${origin}/`)
  expect(res.status).toBe(500)
  expect(res.headers.get("content-type")).toContain("text/html")
  const html = await res.text()
  expect(html).toContain("loader exploded in dev")
})

test("the Vite pipeline exposes the same structured last-error endpoint as Bun", async () => {
  const origin = await start(() => {
    throw new Error("vite loader exploded")
  })
  const before = await fetch(`${origin}${LAST_ERROR_PATH}`)
  expect(before.headers.get("x-nifra-diagnostic")).toBe("true")
  expect(((await before.json()) as { code: string }).code).toBe("NIFRA_NONE")

  expect((await fetch(`${origin}/`)).status).toBe(500)
  const after = await fetch(`${origin}${LAST_ERROR_PATH}`)
  const diagnostic = (await after.json()) as { code: string; message: string; request: unknown }
  expect(diagnostic.code).toBe("NIFRA_UNHANDLED")
  expect(diagnostic.message).toContain("vite loader exploded")
  expect(diagnostic.request).toEqual({ method: "GET", url: "/" })
})

test("a non-HTML response is streamed through untouched", async () => {
  // Only HTML gets Vite's client injected. Rewriting anything else would corrupt JSON and binary
  // responses served by the same app in dev.
  const origin = await start(() => Response.json({ ok: true, marker: "<html>not really</html>" }))
  const res = await fetch(`${origin}/api/data`)
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ ok: true, marker: "<html>not really</html>" })
})

test("an HTML response gets Vite's client injected so HMR can connect", async () => {
  const origin = await start(
    () =>
      new Response("<!doctype html><html><head></head><body>hi</body></html>", {
        headers: { "content-type": "text/html" },
      }),
  )
  const html = await (await fetch(`${origin}/`)).text()
  expect(html).toContain("hi")
  expect(html).toContain("/@vite/client")
})

// Stands in for `@vitejs/plugin-react`'s refresh preamble: an inline module script on every page.
const preamble = {
  name: "test-preamble",
  transformIndexHtml: () => [
    {
      tag: "script",
      attrs: { type: "module" },
      children: "window.__preamble = 1",
      injectTo: "head",
    },
  ],
}

const page = (head: string, headers: Record<string, string>) => () =>
  new Response(`<!doctype html><html><head>${head}</head><body>hi</body></html>`, {
    headers: { "content-type": "text/html", ...headers },
  })

/** Every `<script>` / `<style>` start tag in a page (not text inside a script), and its nonce. */
const tagNonces = (html: string): Array<string | undefined> =>
  [
    ...html
      .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, "$1")
      .matchAll(/<(?:script|style)\b([^>]*)>/gi),
  ].map((match) => /\bnonce="([^"]*)"/.exec(match[1] ?? "")?.[1])

test("an HTML page keeps the app's response headers", async () => {
  // The HTML path rewrites the body for Vite's client, and it used to rebuild the headers from
  // nothing: a loader's cookie, the CSP, cache-control and vary reached the browser under Bun dev
  // and were dropped under Vite dev.
  const origin = await start(() => {
    const headers = new Headers({
      "content-type": "text/html",
      "cache-control": "private, no-store",
      vary: "cookie",
      "x-nifra-status": "200",
      // The app's length, for the body before Vite's client was injected.
      "content-length": "52",
    })
    headers.append("set-cookie", "session=1; Path=/; HttpOnly")
    headers.append("set-cookie", "theme=dark; Path=/")
    return new Response("<!doctype html><html><head></head><body>hi</body></html>", { headers })
  })
  const res = await fetch(`${origin}/`)
  expect(res.headers.getSetCookie()).toEqual(["session=1; Path=/; HttpOnly", "theme=dark; Path=/"])
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  expect(res.headers.get("vary")).toBe("cookie")
  expect(res.headers.get("x-nifra-status")).toBe("200")
  const html = await res.text()
  expect(html).toContain("/@vite/client")
  expect(html).toEndWith("</html>")
})

test("a nonce page: Vite's tags carry the page's nonce, and so may its runtime styles", async () => {
  const origin = await start(
    page(`<script nonce="pagenonce">window.__s = "<style>"</script>`, {
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'nonce-pagenonce'; object-src 'none'",
    }),
    [preamble],
  )
  const res = await fetch(`${origin}/`)
  const html = await res.text()
  expect(html).toContain("window.__preamble = 1")
  expect(tagNonces(html).length).toBeGreaterThanOrEqual(3)
  expect(new Set(tagNonces(html))).toEqual(new Set(["pagenonce"]))
  // A script body is not markup: the string in it is left as written.
  expect(html).toContain(`window.__s = "<style>"`)
  // Vite's client reads this to nonce the <style> it adds for each imported stylesheet.
  expect(html).toContain(`<meta property="csp-nonce" nonce="pagenonce">`)
  // script-src already names the nonce; styles fall back to default-src, which now does too.
  expect(res.headers.get("content-security-policy")).toBe(
    "default-src 'self' 'nonce-pagenonce'; script-src 'self' 'nonce-pagenonce'; object-src 'none'",
  )
})

test("a hash page: Vite's tags get a dev nonce that the policy names", async () => {
  const origin = await start(
    page("<script>window.__app = 1</script>", {
      "content-security-policy": "script-src 'self' 'sha256-abc='; style-src 'self'",
    }),
    [preamble],
  )
  const res = await fetch(`${origin}/`)
  const nonces = new Set(tagNonces(await res.text()))
  expect(nonces.size).toBe(1)
  const [nonce] = nonces
  expect(nonce).toMatch(/^[A-Za-z0-9]{16,}$/)
  expect(res.headers.get("content-security-policy")).toBe(
    `script-src 'self' 'sha256-abc=' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'`,
  )
})

test("a directive that already allows inline is left alone", async () => {
  // A nonce in a directive switches its 'unsafe-inline' off, which would break the app's own inline
  // styles - and Vite's tags are allowed there already.
  const origin = await start(
    page(`<script nonce="p">1</script>`, {
      "content-security-policy": "script-src 'nonce-p'; style-src 'self' 'unsafe-inline'",
      "content-security-policy-report-only": "default-src 'self' 'unsafe-inline'",
    }),
    [preamble],
  )
  const res = await fetch(`${origin}/`)
  expect(res.headers.get("content-security-policy")).toBe(
    "script-src 'nonce-p'; style-src 'self' 'unsafe-inline'",
  )
  expect(res.headers.get("content-security-policy-report-only")).toBe(
    "default-src 'self' 'unsafe-inline'",
  )
})

test("a page with no CSP gets no nonces", async () => {
  const origin = await start(page("<script>1</script>", {}), [preamble])
  const html = await (await fetch(`${origin}/`)).text()
  expect(tagNonces(html).every((nonce) => nonce === undefined)).toBe(true)
  expect(html).not.toContain("csp-nonce")
})

test("a bind failure names the port and leaves nothing running", async () => {
  // Vite is fully up by the time the listen fails - watchers, dep optimizer, its own sockets - and each
  // keeps the event loop alive. Without tearing it down the process prints the diagnosis and then HANGS
  // on it, which reads as a dev server that is still starting. This test would hang, not fail, on a
  // regression, so it is bounded by the runner's own timeout rather than an assertion.
  const held = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") })
  try {
    let raised: Error | undefined
    try {
      await createViteDevServer({
        root,
        routesDir,
        clientModule: join(root, "client.ts"),
        port: held.port ?? 0,
        createApp: () => ({ fetch: () => new Response("never reached") }),
      })
    } catch (error) {
      raised = error as Error
    }
    expect(raised).toBeDefined()
    // The message has to name the port; "EADDRINUSE" alone sends you looking at the wrong thing.
    expect(raised?.message).toContain(String(held.port))
    // The port is still the original server's - the failed start did not steal or free it.
    expect(await (await fetch(`http://127.0.0.1:${held.port}/`)).text()).toBe("occupied")
  } finally {
    held.stop(true)
  }
}, 60_000)

test("the Vite dev server feeds the same agent surface as the Bun one", async () => {
  const origin = await start((request, dev) => {
    const path = new URL(request.url).pathname
    console.warn(`vite saw ${path}`)
    if (path === "/broken") {
      dev.onLoaderError(new Error("vite loader failed"), { request, route: "/broken" })
      return new Response("<html><head></head><body>boundary</body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      })
    }
    if (path === "/thrown") throw new Error("vite render threw")
    return Response.json({ ok: true })
  })
  const record = readDevServerRecord(root)
  expect(record?.pipeline).toBe("vite")
  expect(`http://127.0.0.1:${record?.port}`).toBe(origin)
  const headers = { [DEV_TOKEN_HEADER]: record?.token ?? "" }

  const api = await fetch(`${origin}/api/ok`)
  expect(api.headers.get(DEV_REQUEST_ID_HEADER)).toMatch(/^r\d+$/)
  const broken = await fetch(`${origin}/broken`)
  const brokenId = broken.headers.get(DEV_REQUEST_ID_HEADER)
  expect(brokenId).toMatch(/^r\d+$/)
  await fetch(`${origin}/thrown`)

  const { errors } = await readJson<{
    errors: Array<{ category: string; requestId?: string; route?: string }>
  }>(await fetch(`${origin}${DEV_FEED_PATHS.errors}`, { headers }))
  expect(errors.map((e) => e.category)).toEqual(["page", "ssr"])
  expect(errors[0]).toEqual(expect.objectContaining({ route: "/broken", requestId: brokenId }))
  const { logs } = await readJson<{ logs: Array<{ message: string; level: string }> }>(
    await fetch(`${origin}${DEV_FEED_PATHS.logs}?requestId=${brokenId}`, { headers }),
  )
  expect(logs).toContainEqual(
    expect.objectContaining({ level: "warn", message: "vite saw /broken" }),
  )
  expect((await fetch(`${origin}${DEV_FEED_PATHS.requests}`)).status).toBe(401)
  // Paths under /__nifra/ that are not the session's still reach Vite and the app.
  expect((await fetch(`${origin}/__nifra/unknown`)).status).toBe(200)
})
