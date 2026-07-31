import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { MCP_CLI_VERSION } from "../src/agent-files.ts"
import { AUTH_PRESETS } from "../src/auth.ts"
import { materializeAll } from "./_scaffold-fixtures.ts"

// Guards the hand-maintained scaffold/template version refs that `changeset version` does NOT update —
// the class that silently drifted to beta at the 1.0.0 cut. `scripts/version.ts` re-syncs them on bump
// and `scripts/check-publish.ts` gates them at publish; this is the same invariant as a fast `bun test`
// so a stale ref surfaces in the normal dev loop, not only when packing for npm. `fixed` changeset
// versioning ([["@nifrajs/*", "create-nifra", "nifra"]]) means @nifrajs/cli's version is the one
// source of truth every internal ref must track.
const PKG_ROOT = join(import.meta.dir, "..") // packages/create-nifra
const PACKAGES = join(PKG_ROOT, "..") // packages

const pkgVersion = async (pkgDir: string): Promise<string> =>
  JSON.parse(await readFile(join(PACKAGES, pkgDir, "package.json"), "utf8")).version

const isInternalDep = (name: string): boolean => name.startsWith("@nifrajs/") || name === "nifra"

describe("version-sync — scaffold/template refs track the published version", () => {
  test("agent-files MCP_CLI_VERSION is derived to equal @nifrajs/cli's version", async () => {
    // Derived from create-nifra's own package.json at load time; under `fixed` versioning that equals
    // @nifrajs/cli — so this also asserts the `fixed` link hasn't broken.
    expect(MCP_CLI_VERSION).toBe(await pkgVersion("cli"))
  })

  test("every scaffold pins @nifrajs/* + nifra deps to ^<cli version>", async () => {
    const expected = `^${await pkgVersion("cli")}`
    // Composed, so this covers the GENERATED manifest a site scaffold ships as well as the manifests
    // the copied templates still carry - the pin used to be a regex sweep over directories, and a
    // site's is now one constant that no sweep would reach.
    const { scaffolds, cleanup } = await materializeAll()
    expect(scaffolds.length).toBeGreaterThan(0) // fail loudly if the set ever comes back empty
    for (const { label: tpl, dir } of scaffolds) {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      for (const block of ["dependencies", "devDependencies"] as const) {
        for (const [name, spec] of Object.entries(pkg[block] ?? {})) {
          if (isInternalDep(name)) {
            expect(spec, `${tpl}/package.json ${block}.${name}`).toBe(expected)
          }
        }
      }
    }
    await cleanup()
  })

  test("auth.ts injects @nifrajs/better-auth at ^<better-auth version>", async () => {
    // Only the internal pin is version-locked; the sibling third-party `better-auth` peer is not.
    expect(AUTH_PRESETS["better-auth"]?.deps["@nifrajs/better-auth"]).toBe(
      `^${await pkgVersion("better-auth")}`,
    )
  })
})
