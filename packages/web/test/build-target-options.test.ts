import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildTarget, generateServerEntry } from "../src/build.ts"

// The generated server entry imports the forwarded `createWebApp` options (`apiPrefix`, `mounts`, ...)
// from the app's framework module, so production serves the app `nifra dev` serves. The unit test pins
// the codegen; the build test proves a real bundled worker honours the imported values.

test("generateServerEntry imports each forwarded option by name and passes it through", () => {
  const source = generateServerEntry({
    target: "bun",
    adapterImport: "/app/backend/framework.ts",
    optionImports: { apiPrefix: "/app/backend/framework.ts", mounts: "/app/backend/framework.ts" },
  })
  expect(source).toContain('import { apiPrefix, mounts } from "/app/backend/framework.ts"')
  expect(source).toMatch(/createWebApp\(\{[\s\S]*\n {2}apiPrefix,\n {2}mounts,\n/)
})

test("generateServerEntry names only options from its own list", () => {
  const source = generateServerEntry({
    target: "bun",
    adapterImport: "/app/backend/framework.ts",
    optionImports: { ["evil(){}" as "apiPrefix"]: "/app/x.ts" },
  })
  expect(source).not.toContain("evil")
  expect(source).not.toContain("/app/x.ts")
})

test("generateServerEntry without optionImports emits no option import", () => {
  const source = generateServerEntry({ target: "bun", adapterImport: "/app/backend/framework.ts" })
  expect(source).not.toContain("apiPrefix")
  expect(source).not.toContain("mounts")
})

const WORKSPACE_TMP_BASE = `${import.meta.dir}/.tmp-build-options-`
let projectRoot: string

beforeEach(() => {
  projectRoot = mkdtempSync(WORKSPACE_TMP_BASE)
  mkdirSync(join(projectRoot, "routes"), { recursive: true })
  writeFileSync(
    join(projectRoot, "routes", "index.tsx"),
    "export default function Home() { return null }\n",
  )
  mkdirSync(join(projectRoot, "backend"), { recursive: true })
  writeFileSync(
    join(projectRoot, "backend/framework.ts"),
    [
      'import { server } from "@nifrajs/core/server"',
      "const streamOf = (s: string) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close() } })",
      "export const adapter = {",
      '  renderToStream: () => streamOf("<p>page</p>"),',
      '  hydrationHead: () => "",',
      "}",
      'export const apiPrefix = "/rpc"',
      'export const mounts = [{ path: "/hooks", app: server().get("/hooks/ping", () => ({ hook: true })) }]',
    ].join("\n"),
  )
  writeFileSync(
    join(projectRoot, "backend/app.ts"),
    [
      'import { server } from "@nifrajs/core/server"',
      'export const backend = server().get("/rpc/ping", () => ({ backend: true }))',
    ].join("\n"),
  )
  mkdirSync(join(projectRoot, "frontend"), { recursive: true })
  writeFileSync(join(projectRoot, "frontend/client-stub.ts"), "export function mountRouter() {}\n")
})
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

test("a built worker mounts the backend at the imported apiPrefix and serves the imported mounts", async () => {
  const outDir = join(projectRoot, "dist")
  const frameworkFile = join(projectRoot, "backend/framework.ts")
  await buildTarget("cloudflare", {
    routesDir: join(projectRoot, "routes"),
    outDir,
    workDir: join(projectRoot, ".work"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: frameworkFile,
    backendImport: join(projectRoot, "backend/app.ts"),
    optionImports: { apiPrefix: frameworkFile, mounts: frameworkFile },
  })
  const worker = (await import(join(outDir, "_worker.js"))) as {
    default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> }
  }
  const call = (path: string) =>
    worker.default.fetch(new Request(`http://x${path}`), {}, { waitUntil() {} })

  expect(await (await call("/rpc/ping")).json()).toEqual({ backend: true })
  expect(await (await call("/hooks/ping")).json()).toEqual({ hook: true })
  // The default prefix is no longer mounted, so /api/* falls to the page router's 404.
  expect((await call("/api/ping")).status).toBe(404)
  expect((await call("/")).status).toBe(200)
}, 60_000)

test('clientIp "platform": a built edge entry keys the backend rate limit on the platform header', async () => {
  writeFileSync(
    join(projectRoot, "backend/limited.ts"),
    [
      'import { server } from "@nifrajs/core/server"',
      'import { MemoryStore, rateLimit } from "@nifrajs/middleware"',
      "export const backend = server()",
      "  .use(rateLimit({ store: new MemoryStore({ allowInProduction: true }), max: 1, windowMs: 60_000 }))",
      '  .get("/api/ip", (c) => ({ ip: c.clientIp ?? null }))',
    ].join("\n"),
  )
  const build = async (target: "cloudflare" | "vercel", clientIp?: "platform") => {
    const outDir = join(projectRoot, `dist-${target}-${clientIp ?? "default"}`)
    await buildTarget(target, {
      routesDir: join(projectRoot, "routes"),
      outDir,
      workDir: join(projectRoot, `.work-${target}-${clientIp ?? "default"}`),
      clientModule: join(projectRoot, "frontend/client-stub.ts"),
      adapterImport: join(projectRoot, "backend/framework.ts"),
      backendImport: join(projectRoot, "backend/limited.ts"),
      ...(clientIp !== undefined ? { clientIp } : {}),
    })
    return outDir
  }
  const cloudflare = async (clientIp?: "platform") => {
    const worker = (await import(join(await build("cloudflare", clientIp), "_worker.js"))) as {
      default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> }
    }
    return (headers: Record<string, string>) =>
      worker.default.fetch(new Request("http://x/api/ip", { headers }), {}, { waitUntil() {} })
  }
  const keyUnavailable = { ok: false, error: "rate_limit_key_unavailable" }

  const trusting = await cloudflare("platform")
  const first = await trusting({ "cf-connecting-ip": "203.0.113.7" })
  expect(first.status).toBe(200)
  expect(await first.json()).toEqual({ ip: "203.0.113.7" })
  // One bucket per visitor: the same address is limited, a different one is not.
  expect((await trusting({ "cf-connecting-ip": "203.0.113.7" })).status).toBe(429)
  expect((await trusting({ "cf-connecting-ip": "198.51.100.4" })).status).toBe(200)
  // Only Cloudflare's own header counts; without it the limit still fails closed.
  const vercelHeader = await trusting({ "x-real-ip": "192.0.2.1" })
  expect(vercelHeader.status).toBe(500)
  expect(await vercelHeader.json()).toEqual(keyUnavailable)

  // Undeclared, the header is never believed.
  const untrusting = await cloudflare()
  const refused = await untrusting({ "cf-connecting-ip": "203.0.113.7" })
  expect(refused.status).toBe(500)
  expect(await refused.json()).toEqual(keyUnavailable)

  const fn = (await import(
    join(await build("vercel", "platform"), "functions/index.func/index.js")
  )) as {
    default(request: Request): Promise<Response>
  }
  const viaVercel = (headers: Record<string, string>) =>
    fn.default(new Request("http://x/api/ip", { headers }))
  expect(await (await viaVercel({ "x-real-ip": "203.0.113.9" })).json()).toEqual({
    ip: "203.0.113.9",
  })
  expect((await viaVercel({ "cf-connecting-ip": "203.0.113.10" })).status).toBe(500)
}, 120_000)
