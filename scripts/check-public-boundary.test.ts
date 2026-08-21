import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { findPublicReferenceFailures, runPublicBoundary } from "./check-public-boundary.ts"

describe("public boundary gate", () => {
  test("accepts an allowlisted disposable reference and rejects an undeclared one", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "nifra-boundary-"))
    mkdirSync(resolve(root, "scripts"), { recursive: true })
    mkdirSync(resolve(root, "packages/agent/src"), { recursive: true })
    await Bun.write(
      resolve(root, "scripts/public-agent-reference-allowlist.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            path: "packages/agent/src/fixture.ts",
            name: "MemoryFixtureStore",
            kind: "memory",
            port: "FixtureStore",
          },
        ],
      }),
    )
    await Bun.write(
      resolve(root, "packages/agent/src/fixture.ts"),
      "export class MemoryFixtureStore {}\n",
    )
    expect(findPublicReferenceFailures(root)).toEqual([])
    await Bun.write(
      resolve(root, "packages/agent/src/fixture.ts"),
      "export class DurableTenantStore {}\n",
    )
    expect(
      findPublicReferenceFailures(root).some((failure) => failure.includes("undeclared")),
    ).toBe(true)
  })

  test("fails closed for release mode without marker configuration", async () => {
    const previous = process.env.PRIVATE_MARKERS
    delete process.env.PRIVATE_MARKERS
    try {
      const failures = await runPublicBoundary({ release: true })
      expect(failures.some((failure) => failure.includes("PRIVATE_MARKERS"))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.PRIVATE_MARKERS
      else process.env.PRIVATE_MARKERS = previous
    }
  })
})
