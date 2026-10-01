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
    adapterImport: "/app/framework.ts",
    optionImports: { apiPrefix: "/app/framework.ts", mounts: "/app/framework.ts" },
  })
  expect(source).toContain('import { apiPrefix, mounts } from "/app/framework.ts"')
  expect(source).toMatch(/createWebApp\(\{[\s\S]*\n {2}apiPrefix,\n {2}mounts,\n/)
})

test("generateServerEntry names only options from its own list", () => {
  const source = generateServerEntry({
    target: "bun",
    adapterImport: "/app/framework.ts",
    optionImports: { ["evil(){}" as "apiPrefix"]: "/app/x.ts" },
  })
  expect(source).not.toContain("evil")
  expect(source).not.toContain("/app/x.ts")
})

test("generateServerEntry without optionImports emits no option import", () => {
  const source = generateServerEntry({ target: "bun", adapterImport: "/app/framework.ts" })
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
  writeFileSync(
    join(projectRoot, "framework.ts"),
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
    join(projectRoot, "backend.ts"),
    [
      'import { server } from "@nifrajs/core/server"',
      'export const backend = server().get("/rpc/ping", () => ({ backend: true }))',
    ].join("\n"),
  )
  writeFileSync(join(projectRoot, "client-stub.ts"), "export function mountRouter() {}\n")
})
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

test("a built worker mounts the backend at the imported apiPrefix and serves the imported mounts", async () => {
  const outDir = join(projectRoot, "dist")
  const frameworkFile = join(projectRoot, "framework.ts")
  await buildTarget("cf-pages", {
    routesDir: join(projectRoot, "routes"),
    outDir,
    workDir: join(projectRoot, ".work"),
    clientModule: join(projectRoot, "client-stub.ts"),
    adapterImport: frameworkFile,
    backendImport: join(projectRoot, "backend.ts"),
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
