import { expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { assertUseIsEdgeExported } from "../src/cli.ts"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

/**
 * The `use` passthrough: an app-level middleware exported from the config must reach the web app the
 * CLI constructs - applied BEFORE the page routes are declared, so it covers page responses, not just
 * `/api/*`. The assertion is on a served PAGE response header, because that is exactly what an app
 * could not harden before this seam existed (only backend.ts, where the app owns `server()`, could).
 */
test(
  "nifra dev (bun): a config `use` middleware covers page responses",
  async () => {
    const root = createFixtureRoot("tmp-nifra-use-")
    let proc: ReturnType<typeof Bun.spawn> | undefined
    try {
      mkdirSync(join(root, "routes"), { recursive: true })
      // Same reasoning as bun-dev-css-modules.test.ts: the fixture declares its own `@nifrajs/*` links
      // so resolution never depends on a root-level link farm that a fresh install doesn't guarantee.
      const nodeModules = join(root, "node_modules", "@nifrajs")
      mkdirSync(nodeModules, { recursive: true })
      for (const pkg of ["web", "web-react"]) {
        symlinkSync(resolve(import.meta.dir, "..", "..", pkg), join(nodeModules, pkg), "dir")
      }
      writeFileSync(
        join(root, "nifra.config.ts"),
        [
          'import { reactAdapter } from "@nifrajs/web-react"',
          "export const adapter = reactAdapter",
          'export const clientModule = "@nifrajs/web-react/client"',
          "export const use = (app: { use(m: unknown): unknown }) => {",
          "  app.use({",
          '    name: "test-stamp",',
          "    onResponse: (response: Response) => {",
          "      const next = new Response(response.body, response)",
          '      next.headers.set("x-app-use", "reached")',
          "      return next",
          "    },",
          "  })",
          "}",
        ].join("\n"),
      )
      writeFileSync(
        join(root, "routes", "index.tsx"),
        ["export default function Home() {", "  return <div>hello</div>", "}"].join("\n"),
      )

      const cli = resolve(import.meta.dir, "../src/cli.ts")
      proc = Bun.spawn(["bun", cli, "dev", "--port", "0"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      let banner = ""
      const deadline = Date.now() + 60_000
      while (!/http:\/\/localhost:\d+/.test(banner) && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        banner += new TextDecoder().decode(value)
      }
      if (!banner.includes("nifra dev (bun)")) {
        const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
        throw new Error(
          `nifra dev printed no banner (exit ${await proc.exited}).\n--- stdout ---\n${banner}\n--- stderr ---\n${stderr}`,
        )
      }
      const port = Number(/http:\/\/localhost:(\d+)/.exec(banner)?.[1])
      expect(Number.isInteger(port)).toBe(true)

      // A PAGE response, not `/api/*` - the whole point of the seam.
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get("x-app-use")).toBe("reached")
    } finally {
      proc?.kill()
      removeFixtureRoot(root)
    }
  },
  { timeout: 90_000 },
)

// --- The split-config guard -------------------------------------------------------------------------
// `nifra build` imports `use` from framework.ts (the edge-bundlable file), while `loadApp` prefers
// nifra.config.ts. A `use` living only in nifra.config.ts would emit an unresolvable import inside
// GENERATED code; the guard refuses it up front with the exact move.

test("guard: `use` in nifra.config.ts without a framework.ts export throws, naming both files", async () => {
  const root = createFixtureRoot("tmp-nifra-use-guard-")
  try {
    const frameworkFile = join(root, "framework.ts")
    const configPath = join(root, "nifra.config.ts")
    writeFileSync(frameworkFile, "export const adapter = {}\n")
    const err = await assertUseIsEdgeExported(() => {}, configPath, frameworkFile).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err?.message).toContain(configPath)
    expect(err?.message).toContain(frameworkFile)
    expect(err?.message).toContain("re-export")
  } finally {
    removeFixtureRoot(root)
  }
})

test("guard: `use` defined in framework.ts and re-exported from nifra.config.ts passes", async () => {
  const root = createFixtureRoot("tmp-nifra-use-guard-")
  try {
    const frameworkFile = join(root, "framework.ts")
    const configPath = join(root, "nifra.config.ts")
    writeFileSync(frameworkFile, "export const use = () => {}\n")
    await assertUseIsEdgeExported(() => {}, configPath, frameworkFile)
  } finally {
    removeFixtureRoot(root)
  }
})

test("guard: no-ops when `use` is absent or the config IS framework.ts", async () => {
  // No `use` → nothing to check, whatever the file layout.
  await assertUseIsEdgeExported(undefined, "/a/nifra.config.ts", "/a/framework.ts")
  // Single-file app: the loaded config is the file the entry imports, so the export must exist.
  await assertUseIsEdgeExported(() => {}, "/a/framework.ts", "/a/framework.ts")
})
