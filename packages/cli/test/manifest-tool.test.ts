import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseNifraManifest } from "@nifrajs/core/manifest"
import { collectCheckResult } from "../src/check.ts"
import {
  DEFAULT_MANIFEST_FILE,
  formatManifestDiff,
  runManifestDiff,
  runManifestEmit,
} from "../src/manifest-tool.ts"

import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

const FIXTURES = createFixtureRoot("tmp-nifra-manifest-fixtures")

afterAll(() => {
  removeFixtureRoot(FIXTURES)
})

async function project(name: string, path = "/health"): Promise<string> {
  const cwd = join(FIXTURES, name)
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(cwd, "backend.ts"),
    `import { server } from "@nifrajs/core"\nexport const backend = server().get(${JSON.stringify(path)}, () => ({ ok: true }))\n`,
  )
  await writeFile(
    join(cwd, "nifra.assurance.ts"),
    `import { defineAssuranceConfig } from "@nifrajs/core/assurance"\nimport { backend } from "./backend.ts"\nexport default defineAssuranceConfig({ source: backend, policy: { rules: [{ name: "all", match: {}, require: [] }] }, manifest: {} })\n`,
  )
  return cwd
}

async function webProject(name: string): Promise<string> {
  const cwd = join(FIXTURES, name)
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(cwd, "web.ts"),
    [
      `import { inProcessClient } from "@nifrajs/client"`,
      `import { server } from "@nifrajs/core"`,
      `import { createWebApp } from "@nifrajs/web"`,
      `const backend = server().get("/health", () => ({ ok: true }))`,
      `const adapter = { renderToStream: () => new ReadableStream<Uint8Array>() }`,
      `export const app = createWebApp({ adapter, manifest: { routes: [], layouts: {}, errors: {} }, clientEntry: "/c.js", api: inProcessClient(backend), apiStrip: true })`,
      "",
    ].join("\n"),
  )
  await writeFile(
    join(cwd, "nifra.assurance.ts"),
    [
      `import { defineAssuranceConfig } from "@nifrajs/core/assurance"`,
      `import { app } from "./web.ts"`,
      `export default defineAssuranceConfig({ source: app, policy: { rules: [{ name: "all", match: {}, require: [] }] }, manifest: {} })`,
      "",
    ].join("\n"),
  )
  return cwd
}

describe("nifra manifest", () => {
  test("emits byte-identical, hash-verified artifacts", async () => {
    const cwd = await project("emit")
    expect(await runManifestEmit(cwd)).toBe(true)
    const path = join(cwd, DEFAULT_MANIFEST_FILE)
    const first = await Bun.file(path).text()
    expect((await parseNifraManifest(first, path)).routes[0]?.path).toBe("/health")
    expect(await runManifestEmit(cwd)).toBe(true)
    expect(await Bun.file(path).text()).toBe(first)
  })

  test("manifest emission consumes composed page and mounted API evidence", async () => {
    const cwd = await webProject("composed-web")
    expect(await runManifestEmit(cwd)).toBe(true)
    const manifest = await parseNifraManifest(
      await Bun.file(join(cwd, DEFAULT_MANIFEST_FILE)).text(),
      join(cwd, DEFAULT_MANIFEST_FILE),
    )
    expect(manifest.routes.map((route) => `${route.method} ${route.path}`)).toContain(
      "GET /api/health",
    )
  })

  test("diff rejects a removed route and tampered artifacts", async () => {
    const before = await project("before", "/kept")
    const after = await project("after", "/replacement")
    await runManifestEmit(before)
    await runManifestEmit(after)
    expect(
      await runManifestDiff(FIXTURES, "before/nifra.manifest.json", "after/nifra.manifest.json", {
        json: true,
      }),
    ).toBe(false)
    const path = join(after, DEFAULT_MANIFEST_FILE)
    await writeFile(path, (await Bun.file(path).text()).replace("replacement", "tampered"))
    await expect(
      runManifestDiff(FIXTURES, "before/nifra.manifest.json", "after/nifra.manifest.json"),
    ).rejects.toThrow("contentHash mismatch")
  })

  test("format makes the promotion verdict explicit", () => {
    expect(formatManifestDiff({ hasBreaking: false, changes: [] })).toBe("No manifest changes.")
    expect(
      formatManifestDiff({
        hasBreaking: true,
        changes: [
          {
            severity: "breaking",
            method: "GET",
            path: "/x",
            section: "route",
            message: "route removed",
          },
        ],
      }),
    ).toContain("1 breaking manifest change.")
  })

  test("nifra check fails closed when the configured trust manifest drifts", async () => {
    const cwd = await project("check-sync")
    expect((await collectCheckResult(cwd, { lintsOnly: true })).diagnostics).toContainEqual(
      expect.objectContaining({ rule: "manifest-drift", severity: "error" }),
    )
    expect(await runManifestEmit(cwd)).toBe(true)
    expect((await collectCheckResult(cwd, { lintsOnly: true })).diagnostics).not.toContainEqual(
      expect.objectContaining({ rule: "manifest-drift" }),
    )
    const path = join(cwd, DEFAULT_MANIFEST_FILE)
    await writeFile(path, (await Bun.file(path).text()).replace("health", "tampered"))
    expect((await collectCheckResult(cwd, { lintsOnly: true })).diagnostics).toContainEqual(
      expect.objectContaining({ rule: "manifest-drift", severity: "error" }),
    )
  })
})
