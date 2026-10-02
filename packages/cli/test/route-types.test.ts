import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { refreshRouteTypes, routeTypesTsconfigIssue } from "../src/route-types.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const CLI = resolve(import.meta.dir, "../src/cli.ts")
let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-route-types-")
})
afterEach(() => removeFixtureRoot(root))

async function nifra(...args: string[]): Promise<{ exit: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { exit, stdout }
}

describe("nifra types", () => {
  test("writes the route types, then --check passes until a route is added", async () => {
    writeAppFile(root, "routes/index.tsx", "export default () => null\n")
    writeAppFile(
      root,
      "tsconfig.json",
      '{ "compilerOptions": { "rootDirs": [".", "./.nifra/types"] } }\n',
    )

    const written = await nifra("types", "--json")
    expect(written.exit).toBe(0)
    const report = JSON.parse(written.stdout) as Record<string, unknown>
    expect(report).toMatchObject({
      ok: true,
      written: [".nifra/types/routes/+types/index.d.ts"],
      removed: [],
    })
    expect(report.tsconfig).toBeUndefined()

    expect((await nifra("types", "--check")).exit).toBe(0)
    writeAppFile(root, "routes/about.tsx", "export default () => null\n")
    const stale = await nifra("types", "--check")
    expect(stale.exit).toBe(1)
    expect(stale.stdout).toContain("stale .nifra/types/routes/+types/about.d.ts")
    expect(existsSync(join(root, ".nifra/types/routes/+types/about.d.ts"))).toBe(false)
  }, 30_000)

  test("says which tsconfig line lets a route import ./+types", async () => {
    writeAppFile(root, "routes/index.tsx", "export default () => null\n")
    writeAppFile(root, "tsconfig.json", '{ "compilerOptions": { "strict": true } }\n')
    const { stdout } = await nifra("types")
    expect(stdout).toContain('add "rootDirs": [".", "./.nifra/types"] to compilerOptions')
  }, 30_000)
})

describe("refreshRouteTypes", () => {
  test("reports a routes tree it cannot read instead of throwing", () => {
    writeAppFile(root, "routes/blog.backend.ts", "export const loader = () => null\n")
    const lines: string[] = []
    refreshRouteTypes(root, (line) => lines.push(line))
    expect(lines).toEqual([expect.stringContaining('"blog.backend.ts" has no frontend half')])
  })
})

describe("routeTypesTsconfigIssue", () => {
  test("reads JSONC and follows a relative extends", () => {
    writeAppFile(
      root,
      "tsconfig.base.json",
      [
        "{",
        "  // the app's shared settings",
        '  "compilerOptions": { "rootDirs": ["./", ".nifra/types/"], },',
        "}",
      ].join("\n"),
    )
    writeAppFile(root, "tsconfig.json", '{ "extends": "./tsconfig.base" }\n')
    expect(routeTypesTsconfigIssue(root)).toBeUndefined()
  })

  test("an own rootDirs replaces the inherited one", () => {
    writeAppFile(
      root,
      "tsconfig.base.json",
      '{ "compilerOptions": { "rootDirs": [".", ".nifra/types"] } }\n',
    )
    writeAppFile(
      root,
      "tsconfig.json",
      '{ "extends": "./tsconfig.base.json", "compilerOptions": { "rootDirs": ["."] } }\n',
    )
    expect(routeTypesTsconfigIssue(root)).toContain('"rootDirs"')
  })

  test("no tsconfig, no issue", () => {
    expect(routeTypesTsconfigIssue(root)).toBeUndefined()
  })
})
