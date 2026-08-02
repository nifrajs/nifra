import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createViteDevServer, LAST_ERROR_PATH, type ViteDevServer } from "../src/vite.ts"

/**
 * What the Vite dev server does with a REQUEST, as opposed to with a file change.
 *
 * The dev server bridges Node's `http` to the app's `fetch`, and the bridge is where dev-only bugs
 * live: a POST whose body never arrives, or a thrown loader that returns a blank page instead of the
 * overlay that says what broke. Both are invisible to a route-discovery test, which is all this file's
 * sibling covers - it never sends a body and never throws.
 */

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
  fetchImpl: (request: Request) => Response | Promise<Response>,
): Promise<string> => {
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    createApp: () => ({ fetch: fetchImpl }),
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
