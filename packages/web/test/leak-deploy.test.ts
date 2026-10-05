import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { buildTarget } from "../src/build.ts"
import { BUILD_TARGETS, type BuildTarget, planBuildTarget } from "../src/build-plan.ts"
import { discoverRoutes } from "../src/fs.ts"
import { createWebApp, type RenderAdapter } from "../src/index.ts"

/**
 * What each deploy target publishes: every file a host can serve is free of backend source, and the
 * worker, which no host serves, still carries it (so the absence is not an import that went missing).
 * Bun, Node and Deno serve only `/assets/*` and the copied public files; the static, Pages and Vercel
 * hosts serve the whole directory except the worker. Every file but the worker is checked either way.
 * A static site has no worker: its prerender reads the backend half in this process instead.
 */

const BACKEND_MARKER = "nifra-leak-deploy-backend-source"
// Assembled at runtime so this file carries no credential-shaped literal.
const STRIPE = ["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("")

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

// Inside the workspace, so the generated server entry's `@nifrajs/web` import resolves.
function fixture(extra: Readonly<Record<string, string>> = {}): string {
  const app = mkdtempSync(`${import.meta.dir}/.tmp-leak-deploy-`)
  roots.push(app)
  const files: Record<string, string> = {
    "routes/index.tsx": "export default function Home() { return null }\n",
    "routes/index.backend.ts": `import { token } from "../backend/token.ts"\nexport const prerender = true\nexport const revalidateTags = [token]\n`,
    "backend/token.ts": `export const token = "${BACKEND_MARKER}"\n`,
    "backend/framework.ts":
      "const streamOf = (s) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close() } })\n" +
      'export const adapter = { renderToStream: () => streamOf("<p>home</p>"), hydrationHead: () => "" }\n',
    "frontend/client-stub.ts": "export function mountRouter() {}\n",
    "public/robots.txt": "User-agent: *\n",
    ...extra,
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(app, path)), { recursive: true })
    writeFileSync(join(app, path), text)
  }
  return app
}

const adapter: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("<p>home</p>"))
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const build = (app: string, target: BuildTarget) =>
  buildTarget(target, {
    prerenderApp: (client) =>
      createWebApp({
        adapter,
        manifest: discoverRoutes(join(app, "routes")),
        clientEntry: client.entry,
      }),
    routesDir: join(app, "routes"),
    outDir: join(app, "dist"),
    workDir: join(app, ".work"),
    clientModule: join(app, "frontend/client-stub.ts"),
    adapterImport: join(app, "backend/framework.ts"),
    publicDir: join(app, "public"),
  })

const filesUnder = (dir: string): string[] =>
  (readdirSync(dir, { recursive: true }) as string[])
    .map((file) => join(dir, file))
    .filter((file) => statSync(file).isFile())

describe("deploy targets publish no backend source", () => {
  for (const target of BUILD_TARGETS) {
    test(target, async () => {
      const app = fixture()
      const outDir = join(app, "dist")
      await build(app, target)
      const plan = planBuildTarget(target, outDir)
      const worker = plan.outputFile
      // The plan names the worker with `/`; Windows lists it with `\`.
      const published = filesUnder(outDir).filter(
        (file) => relative(outDir, file).replaceAll("\\", "/") !== worker?.replaceAll("\\", "/"),
      )
      expect(published.map((file) => relative(outDir, file))).toContain(
        join(plan.staticDir, "robots.txt"),
      )
      for (const file of published) {
        expect({
          file: relative(outDir, file),
          leaked: readFileSync(file, "utf8").includes(BACKEND_MARKER),
        }).toEqual({
          file: relative(outDir, file),
          leaked: false,
        })
      }
      if (worker !== undefined) {
        expect(readFileSync(join(outDir, worker), "utf8")).toContain(BACKEND_MARKER)
      }
    })
  }

  test("a credential in public/ fails every target before anything is written", async () => {
    for (const target of BUILD_TARGETS) {
      const app = fixture({ "public/config.json": `{ "key": "${STRIPE}" }\n` })
      await expect(build(app, target)).rejects.toThrow(
        "[nifra/web] the build would publish what looks like a credential:",
      )
      expect(filesUnder(join(app, "dist")).map((file) => relative(app, file))).not.toContain(
        "dist/config.json",
      )
    }
  })
})
