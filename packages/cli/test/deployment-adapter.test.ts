import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const CLI = resolve(import.meta.dir, "../src/cli.ts")
const FLY_ADAPTER = resolve(import.meta.dir, "../../deploy-fly/src/index.ts")
let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-deployment-adapter-")
  writeAppFile(root, "routes/index.tsx", "export default function Home() { return null }\n")
  writeAppFile(root, "frontend/client.ts", "export function mountRouter() {}\n")
  writeAppFile(
    root,
    "backend/framework.ts",
    `export const adapter = {
  renderToStream: () => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<html></html>")); controller.close() } }),
  hydrationHead: () => "",
}
export const clientModule = new URL("../frontend/client.ts", import.meta.url).pathname
`,
  )
  writeAppFile(
    root,
    "nifra.config.ts",
    `import { flyAdapter } from ${JSON.stringify(FLY_ADAPTER)}
export { adapter, clientModule } from "./backend/framework.ts"
export const target = "fly"
export const deploymentAdapter = { adapter: flyAdapter, options: { app: "nifra-cli-test" } }
`,
  )
})
afterEach(() => removeFixtureRoot(root))

async function nifra(...args: string[]): Promise<{ exit: number; out: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exit, out: stdout + stderr }
}

test("nifra build resolves a public adapter target and emits a complete Fly package", async () => {
  const result = await nifra("build", "--target", "fly")
  if (result.exit !== 0) throw new Error(result.out)
  expect(result.exit).toBe(0)
  expect(result.out).toContain("nifra build (fly, base node,")
  expect(result.out).toContain("from output directory: fly deploy")
  expect(existsSync(join(root, "dist", "server.js"))).toBe(true)
  expect(existsSync(join(root, "dist", "assets", "manifest.json"))).toBe(true)
  expect(readFileSync(join(root, "dist", "Dockerfile"), "utf8")).toContain(
    'CMD ["node", "server.js"]',
  )
  expect(readFileSync(join(root, "dist", "fly.toml"), "utf8")).toContain('app = "nifra-cli-test"')
}, 60_000)

test("refuses to bundle build-time adapter config as the deployed runtime module", async () => {
  // Remove the separate runtime module; the Nifra app must fail before replacing its output.
  rmSync(join(root, "backend"), { recursive: true, force: true })
  writeAppFile(root, "dist/keep.txt", "last good build")
  writeAppFile(
    root,
    "nifra.config.ts",
    `import { flyAdapter } from ${JSON.stringify(FLY_ADAPTER)}
export const adapter = {}
export const clientModule = "./frontend/client.ts"
export const target = "fly"
export const deploymentAdapter = { adapter: flyAdapter, options: { app: "nifra-cli-test" } }
`,
  )

  const result = await nifra("build", "--target", "fly")
  expect(result.exit).not.toBe(0)
  expect(result.out).toContain("deploymentAdapter is build-time config")
  expect(readFileSync(join(root, "dist/keep.txt"), "utf8")).toBe("last good build")
})

test("requires the configured custom target id instead of silently selecting Bun", async () => {
  writeAppFile(
    root,
    "nifra.config.ts",
    readFileSync(join(root, "nifra.config.ts"), "utf8").replace(
      'export const target = "fly"\n',
      "",
    ),
  )
  writeAppFile(root, "dist/keep.txt", "last good build")

  const result = await nifra("build")
  expect(result.exit).not.toBe(0)
  expect(result.out).toContain('deploymentAdapter "fly" is configured')
  expect(result.out).toContain('set target = "fly"')
  expect(readFileSync(join(root, "dist/keep.txt"), "utf8")).toBe("last good build")
})
