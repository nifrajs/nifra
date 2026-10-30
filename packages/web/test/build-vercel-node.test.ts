import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { BunPlugin } from "bun"
import { buildTarget, buildTargetWith, bunBundler, generateServerEntry } from "../src/build.ts"
import type { Bundler } from "../src/build-plan.ts"
import { buildTargetVite } from "../src/build-vite.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(`${import.meta.dir}/.tmp-vercel-node-`)
  write("routes/index.tsx", "export default function Home() { return null }")
  write("routes/other.tsx", "export default function Other() { return null }")
  write("frontend/client.ts", "export function mountRouter() {}")
  write(
    "backend/framework.ts",
    `export const apiPrefix = "/api"
export const adapter = {
  hydrationHead: () => "",
  renderToStream(chain, props) {
    return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("<h1>SSR " + JSON.stringify(props.data) + "</h1>")); c.close() } })
  }
}`,
  )
  write(
    "routes/index.backend.ts",
    `import { createHash } from "node:crypto"
import { t } from "@nifrajs/schema"
export const loaderOutput = t.object({ hash: t.string() })
export function loader() { return { hash: createHash("sha256").update("node").digest("hex") } }`,
  )
  write(
    "backend/app.ts",
    `import { server } from "@nifrajs/core/server"
import { createHash } from "node:crypto"
let cancelled = false, aborted = false
export const backend = server()
  .post("/api/echo", async (c) => ({ body: await c.req.text(), hash: createHash("sha256").update("node").digest("hex") }))
  .get("/api/cookies", () => { const headers = new Headers(); headers.append("set-cookie", "a=1; Path=/"); headers.append("set-cookie", "b=2; Path=/"); return new Response("cookies", { headers }) })
  .get("/api/url", (c) => c.req.url)
  .get("/api/state", () => ({ cancelled, aborted }))
  .get("/api/stream", (c) => {
    c.req.signal.addEventListener("abort", () => { aborted = true }, { once: true })
    let timer
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("first")); timer = setInterval(() => controller.enqueue(new TextEncoder().encode("later")), 500) },
      cancel() { cancelled = true; clearInterval(timer) }
    }))
  })`,
  )
  write("public/.well-known/proof.txt", "static proof")
  // These are public paths, not deployment metadata: static/ keeps them separate from the function.
  write("public/config.json", "public config")
  write("public/functions/index.func/index.js", "public script")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function write(file: string, text: string): void {
  const path = join(root, file)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

// Resolve workspace source without generating dist/ artifacts. Real consumers resolve published JS.
function workspaceSource(spec: string): string | undefined {
  const match = /^@nifrajs\/(web|core|client|schema)(\/.*)?$/.exec(spec)
  if (!match) return undefined
  const pkg = join(import.meta.dir, "../../", match[1] ?? "")
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"))
  const entry = manifest.exports[match[2] ? `.${match[2]}` : "."]
  const source = typeof entry === "string" ? entry : entry?.bun
  return source ? join(pkg, source) : undefined
}
const sourcePlugin: BunPlugin = {
  name: "workspace-source",
  setup(build) {
    build.onResolve({ filter: /^@nifrajs\// }, ({ path }) => {
      const source = workspaceSource(path)
      return source ? { path: source } : undefined
    })
  },
}
const viteSourcePlugin = { name: "workspace-source", resolveId: workspaceSource }
const options = () => ({
  routesDir: join(root, "routes"),
  outDir: join(root, ".vercel/output"),
  workDir: join(root, ".work"),
  clientModule: join(root, "frontend/client.ts"),
  adapterImport: join(root, "backend/framework.ts"),
  backendImport: join(root, "backend/app.ts"),
  optionImports: { apiPrefix: join(root, "backend/framework.ts") },
})

for (const pipeline of ["bun", "vite"] as const) {
  test(`ordinary Vercel Node (${pipeline}) emits a Node-runnable SSR + API function`, async () => {
    const pipelinePlugins: readonly { name: string }[] =
      pipeline === "bun" ? [sourcePlugin] : [viteSourcePlugin]
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the shared options are Bun-typed but forward plugins unchanged; the selected build below consumes only the matching pipeline's hooks.
    const plugins = pipelinePlugins as readonly BunPlugin[]
    const build = pipeline === "bun" ? buildTarget : buildTargetVite
    const result = await build("vercel", {
      ...options(),
      vercelRuntime: "node",
      clientPlugins: plugins,
      serverPlugins: plugins,
    })
    const out = join(root, ".vercel/output")
    const fn = join(out, "functions/index.func")
    expect(JSON.parse(readFileSync(join(out, "config.json"), "utf8"))).toEqual({
      version: 3,
      routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }],
    })
    expect(JSON.parse(readFileSync(join(fn, ".vc-config.json"), "utf8"))).toEqual({
      runtime: "nodejs22.x",
      handler: "index.js",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
    })
    expect(JSON.parse(readFileSync(join(fn, "package.json"), "utf8"))).toEqual({ type: "module" })
    expect(readFileSync(join(out, "static/.well-known/proof.txt"), "utf8")).toBe("static proof")
    expect(readFileSync(join(out, "static/config.json"), "utf8")).toBe("public config")
    expect(readFileSync(join(out, "static/functions/index.func/index.js"), "utf8")).toBe(
      "public script",
    )
    expect(Object.keys(result.client.routes).length).toBeGreaterThanOrEqual(2)
    for (const asset of result.client.assets)
      expect(existsSync(join(out, "static", asset))).toBe(true)
    expect(existsSync(join(root, ".work"))).toBe(false)
    const entry = join(fn, "index.js")
    expect(readFileSync(entry, "utf8")).not.toMatch(
      /\bBun\s*\.\s*\w+\s*\(|\btypeof Bun\b|["']bun:[^"']*["']/,
    )
    const code = `
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer, Server, request as httpRequest } from "node:http"
const listen = Server.prototype.listen
Server.prototype.listen = () => { throw new Error("handler listened at import") }
const { default: handler } = await import(${JSON.stringify(pathToFileURL(entry).href)})
Server.prototype.listen = listen
assert.equal(typeof handler, "function")
const server = createServer(handler)
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const base = "http://127.0.0.1:" + server.address().port
const raw = (path, host = "app.example") => new Promise((resolve, reject) => {
  const req = httpRequest(base, { path, headers: { host } }, res => { let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode, body })) })
  req.on("error", reject); req.end()
})
try {
  const page = await fetch(base)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(html.includes("<h1>SSR"))
  assert.ok(html.includes(createHash("sha256").update("node").digest("hex")))
  assert.ok(html.includes(${JSON.stringify(result.client.entry)}))
  const post = await fetch(base + "/api/echo", { method: "POST", body: "incoming body" })
  assert.deepEqual(await post.json(), { body: "incoming body", hash: createHash("sha256").update("node").digest("hex") })
  const cookies = await fetch(base + "/api/cookies")
  assert.deepEqual(cookies.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"])
  assert.equal(await cookies.text(), "cookies")
  const head = await fetch(base, { method: "HEAD" })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), "")
  const stream = await fetch(base + "/api/stream")
  const reader = stream.body.getReader()
  const first = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error("buffered stream")), 300))])
  assert.equal(new TextDecoder().decode(first.value), "first")
  await reader.cancel()
  let state
  for (let i = 0; i < 50; i++) { state = await (await fetch(base + "/api/state")).json(); if (state.cancelled && state.aborted) break; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.deepEqual(state, { cancelled: true, aborted: true })
  const absolute = await raw("http://evil.example/api/url?x=1")
  assert.equal(absolute.status, 200)
  assert.ok(absolute.body.includes("https://app.example/api/url?x=1"))
  assert.equal((await raw("/api/url", "evil.example/path")).status, 400)
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
`
    const proc = Bun.spawn([Bun.which("node") ?? "node", "--input-type=module", "-e", code], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
  }, 120_000)
}

test("invalid Vercel runtime settings leave output and work directories untouched", async () => {
  for (const [target, runtime] of [
    ["vercel", "invalid"],
    ["node", "node"],
    ["bun", "edge"],
    ["static", "node"],
  ] as const) {
    write(".vercel/output/keep", "last deploy")
    write(".work/keep", "last work")
    let builds = 0
    const bundler: Bundler = {
      ...bunBundler,
      buildClient: async () => {
        builds++
        throw new Error("should not build")
      },
    }
    await expect(
      // @ts-expect-error Deliberately invalid runtime strings must fail before any build or directory mutation.
      buildTargetWith(target, { ...options(), vercelRuntime: runtime }, bundler),
    ).rejects.toThrow("vercelRuntime")
    expect(builds).toBe(0)
    expect(readFileSync(join(root, ".vercel/output/keep"), "utf8")).toBe("last deploy")
    expect(readFileSync(join(root, ".work/keep"), "utf8")).toBe("last work")
  }
})

test("Edge remains the Vercel default; Node entry exports a handler without serve/listen", () => {
  const base = { target: "vercel", adapterImport: "./framework.ts" } as const
  const edge = generateServerEntry(base)
  expect(generateServerEntry({ ...base, vercelRuntime: "edge" })).toBe(edge)
  expect(edge).toContain('export const config = { runtime: "edge" }')
  const node = generateServerEntry({ ...base, vercelRuntime: "node" })
  expect(node).toContain("export default handle")
  expect(node).not.toMatch(/Bun|\.listen\(|\bserve\(/)
})

for (const pipeline of ["bun", "vite"] as const) {
  test(`Vercel Edge (${pipeline}) keeps the default Build Output API shape`, async () => {
    write("routes/index.backend.ts", "export const prerender = true")
    write(
      "backend/app.ts",
      'import { server } from "@nifrajs/core/server"; export const backend = server().get("/api/health", () => ({ ok: true }))',
    )
    const pipelinePlugins: readonly { name: string }[] =
      pipeline === "bun" ? [sourcePlugin] : [viteSourcePlugin]
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the shared options are Bun-typed but forward plugins unchanged; the selected build below consumes only the matching pipeline's hooks.
    const plugins = pipelinePlugins as readonly BunPlugin[]
    const build = pipeline === "bun" ? buildTarget : buildTargetVite
    await build("vercel", { ...options(), clientPlugins: plugins, serverPlugins: plugins })
    const out = join(root, ".vercel/output")
    const fn = join(out, "functions/index.func")
    expect(JSON.parse(readFileSync(join(fn, ".vc-config.json"), "utf8"))).toEqual({
      runtime: "edge",
      entrypoint: "index.js",
    })
    expect(existsSync(join(fn, "package.json"))).toBe(false)
    expect(JSON.parse(readFileSync(join(out, "config.json"), "utf8"))).toEqual({
      version: 3,
      routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }],
    })
    expect(existsSync(join(out, "static/.well-known/proof.txt"))).toBe(true)
  }, 120_000)
}

test("Vercel Node does not depend on the self-hosted Node adapter or its version guard", async () => {
  write(
    "node_modules/@nifrajs/node/package.json",
    JSON.stringify({ name: "@nifrajs/node", version: "0.0.1", main: "index.js" }),
  )
  write(
    "node_modules/@nifrajs/node/index.js",
    'throw new Error("must not import the self-hosted adapter")',
  )
  const code = generateServerEntry({
    target: "vercel",
    vercelRuntime: "node",
    adapterImport: "./framework.ts",
  })
  expect(code).not.toContain("@nifrajs/node")
  await buildTarget("vercel", {
    ...options(),
    vercelRuntime: "node",
    clientPlugins: [sourcePlugin],
    serverPlugins: [sourcePlugin],
  })
  expect(existsSync(join(root, ".vercel/output/functions/index.func/index.js"))).toBe(true)
})
