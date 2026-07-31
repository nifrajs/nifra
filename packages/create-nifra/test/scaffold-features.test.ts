import { describe, expect, test } from "bun:test"
import { applyFeatures, type ScaffoldManifest } from "../src/scaffold/features.ts"

/**
 * `--db`, `--auth`, `--deploy` and `--ci` each used to spread themselves over the parsed manifest, in
 * whatever order their handlers happened to sit in. Last writer won, silently. A preset that shadowed
 * the scaffold's own `check` script would have taken the assurance gate off every project scaffolded
 * with it, and nothing anywhere would have said so.
 *
 * No shipped preset does that - all six were checked before this was written - which is the moment to
 * add the rail rather than after someone adds the seventh.
 */

const site = (): ScaffoldManifest => ({
  name: "app",
  scripts: { build: "bun run build.ts", check: "nifra check && nifra assure" },
  dependencies: { "@nifrajs/web": "^2.2.0" },
  devDependencies: { typescript: "^6.0.3" },
})

describe("applyFeatures", () => {
  test("additions from several features land together", () => {
    const manifest = site()
    applyFeatures(manifest, [
      {
        label: "--db drizzle-libsql",
        dependencies: { "drizzle-orm": "^0.36.0" },
        scripts: { "db:migrate": "drizzle-kit migrate" },
      },
      { label: "--auth better-auth", dependencies: { "better-auth": "^1.0.0" } },
    ])
    expect(manifest.dependencies).toEqual({
      "@nifrajs/web": "^2.2.0",
      "drizzle-orm": "^0.36.0",
      "better-auth": "^1.0.0",
    })
    expect(manifest.scripts?.["db:migrate"]).toBe("drizzle-kit migrate")
    // Untouched, which is the property that matters: the assurance gate survives every feature.
    expect(manifest.scripts?.check).toBe("nifra check && nifra assure")
  })

  test("a declared replacement is allowed - that is what --deploy is for", () => {
    const manifest = site()
    applyFeatures(manifest, [
      {
        label: "--deploy vercel",
        scripts: { build: "bun run build-vercel.ts", deploy: "vercel deploy --prebuilt" },
        replaces: ["build", "deploy"],
      },
    ])
    expect(manifest.scripts?.build).toBe("bun run build-vercel.ts")
    expect(manifest.scripts?.deploy).toBe("vercel deploy --prebuilt")
  })

  test("taking a key from the scaffold without declaring it is refused, and names both sides", () => {
    const manifest = site()
    expect(() =>
      applyFeatures(manifest, [{ label: "--db rogue", scripts: { check: "echo skipped" } }]),
    ).toThrow(/--db rogue would overwrite scripts\.check from the scaffold/)
    // Refused, not half-applied.
    expect(manifest.scripts?.check).toBe("nifra check && nifra assure")
  })

  test("two features wanting the same key is refused, naming the one that got there first", () => {
    expect(() =>
      applyFeatures(site(), [
        { label: "--db a", scripts: { "db:migrate": "a migrate" } },
        { label: "--auth b", scripts: { "db:migrate": "b migrate" } },
      ]),
    ).toThrow(/--auth b would overwrite scripts\.db:migrate from --db a/)
  })

  test("agreeing on a value is not a collision", () => {
    // Two features that both need `drizzle-orm` at the same range are not in conflict, and making
    // them declare a replacement for it would be noise that teaches people to add `replaces` freely.
    const manifest = site()
    applyFeatures(manifest, [
      { label: "--db x", dependencies: { "drizzle-orm": "^0.36.0" } },
      { label: "--auth y", dependencies: { "drizzle-orm": "^0.36.0" } },
    ])
    expect(manifest.dependencies?.["drizzle-orm"]).toBe("^0.36.0")
  })
})
