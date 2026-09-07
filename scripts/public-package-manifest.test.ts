import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
  PUBLIC_PACKAGE_SPECS,
  publishedPackages,
  readPackageManifest,
} from "./public-package-manifest.ts"

const ROOT = resolve(import.meta.dir, "..")

describe("public package inventory", () => {
  test("the checked-in workspace matches the explicit public inventory", () => {
    const declared = PUBLIC_PACKAGE_SPECS.map((spec) => spec.dir)
    const discovered = publishedPackages(ROOT).map((pkg) => pkg.dir)
    expect(discovered).toEqual([...declared].sort())
  })

  test("keeps the validation profile with the package identity", () => {
    const packages = new Map(publishedPackages(ROOT).map((pkg) => [pkg.dir, pkg]))
    expect(packages.get("core")?.publishValidation).toBe("library")
    expect(packages.get("cli")?.publishValidation).toBe("publint-only")
    expect(packages.get("web-svelte")?.publishValidation).toBe("publint-only")
  })

  test("discovers a new manifest so the release gate can reject an unclassified package", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "nifra-package-inventory-"))
    await mkdir(resolve(root, "packages", "new-package"), { recursive: true })
    await writeFile(
      resolve(root, "packages", "new-package", "package.json"),
      JSON.stringify({ name: "@nifrajs/new-package", version: "0.0.0" }),
    )

    const [pkg] = publishedPackages(root)
    expect(pkg?.dir).toBe("new-package")
    expect(pkg?.publishValidation).toBe("library")
    expect(readPackageManifest(root, "new-package")?.name).toBe("@nifrajs/new-package")
  })
})
