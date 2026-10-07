import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { generateServerManifest } from "../src/internal/codegen.ts"
import { buildManifest, type RouteModule } from "../src/manifest.ts"
import {
  browserDenial,
  type Classification,
  createZoneClassifier,
  importAllowed,
  importRuleMessage,
  parseZoneConfig,
  ZoneConfigError,
} from "../src/zones.ts"

const root = mkdtempSync(join(tmpdir(), "nifra-zones-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const write = (path: string, text = "export {}\n"): string => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

const app = join(root, "app")
for (const file of [
  "app/routes/index.tsx",
  "app/routes/index.backend.ts",
  "app/routes/blog/[slug].vue",
  "app/routes/_layout.backend.ts",
  "app/routes/feed.shared.ts",
  "app/frontend/Button.tsx",
  "app/frontend/oops.backend.ts",
  "app/backend/app.ts",
  "app/backend/db/client.ts",
  "app/backend/notes.fn.ts",
  "app/backend/report.fn.vue",
  "app/routes/chart.fn.svelte",
  "app/lib/post.fn.mdx",
  "app/backend/view.frontend.tsx",
  "app/shared/format.ts",
  "app/lib/helpers.ts",
  "app/lib/money.shared.ts",
  "app/lib/legacy.server.ts",
  "app/backend.ts",
  "app/.nifra/types/index.d.ts",
  "app/node_modules/pg/index.js",
  "app/node_modules/@scope/ui/index.js",
  "app/node_modules/drizzle-orm/index.js",
  "app/node_modules/flagged/index.js",
  "packages/ui-kit/src/index.ts",
  "packages/db/src/index.ts",
  "packages/loose/src/index.ts",
]) {
  write(file)
}
write(
  "app/node_modules/flagged/package.json",
  '{ "name": "flagged", "nifra": { "environment": "backend" } }',
)
write(
  "packages/ui-kit/package.json",
  '{ "name": "@ws/ui-kit", "nifra": { "environment": "library" } }',
)
write("packages/db/package.json", '{ "name": "@ws/db", "nifra": { "environment": "backend" } }')
write("packages/loose/package.json", '{ "name": "@ws/loose" }')
mkdirSync(join(app, "node_modules/@ws"), { recursive: true })
symlinkSync(join(root, "packages/ui-kit"), join(app, "node_modules/@ws/ui-kit"))
symlinkSync(join(root, "packages/db"), join(app, "node_modules/@ws/db"))
symlinkSync(join(root, "packages/loose"), join(app, "node_modules/@ws/loose"))

const zones = createZoneClassifier({ appRoot: app })
const zoneOf = (path: string): Classification => zones.classify(join(app, path))

describe("createZoneClassifier", () => {
  test.each([
    ["routes/index.tsx", "route-frontend"],
    ["routes/index.backend.ts", "route-backend"],
    ["routes/blog/[slug].vue", "route-frontend"],
    ["routes/_layout.backend.ts", "route-backend"],
    ["routes/feed.shared.ts", "shared"],
    ["frontend/Button.tsx", "frontend"],
    ["backend/app.ts", "backend"],
    ["backend/db/client.ts", "backend"],
    ["backend/notes.fn.ts", "fn"],
    ["shared/format.ts", "shared"],
    ["lib/money.shared.ts", "shared"],
    [".nifra/types/index.d.ts", "generated"],
  ] as const)("%s is %s", (path, zone) => {
    expect(zoneOf(path).zone).toBe(zone)
  })

  test("a routes directory made after the classifier holds routes, whatever the root's spelling", () => {
    const real = join(root, "late-routes")
    mkdirSync(real)
    // A second spelling of one directory, as a Windows short name or a symlinked temp dir gives.
    const alias = join(root, "late-routes-alias")
    symlinkSync(real, alias)
    const late = createZoneClassifier({ appRoot: alias })
    mkdirSync(join(real, "routes"))
    writeFileSync(join(real, "routes/page.tsx"), "export default () => null\n")
    expect(late.classify(join(real, "routes/page.tsx"))).toEqual({ zone: "route-frontend" })
    expect(late.classify(join(alias, "routes/page.tsx"))).toEqual({ zone: "route-frontend" })
  })

  test("a file in no zone is an error, never a default", () => {
    const result = zoneOf("lib/helpers.ts")
    expect(result.zone).toBe("error")
    expect(result.zone === "error" && result.reason).toContain("is in no zone")
  })

  test("a folder and a contradicting suffix are an error", () => {
    for (const path of ["frontend/oops.backend.ts", "backend/view.frontend.tsx"]) {
      const result = zoneOf(path)
      expect(result.zone).toBe("error")
      expect(result.zone === "error" && result.reason).toContain("says otherwise")
    }
  })

  test("a .fn file the browser build cannot turn into calls is an error, not a server function", () => {
    for (const path of ["backend/report.fn.vue", "routes/chart.fn.svelte", "lib/post.fn.mdx"]) {
      const result = zoneOf(path)
      expect({ path, zone: result.zone }).toEqual({ path, zone: "error" })
      expect(result.zone === "error" && result.reason).toContain("only a script module")
    }
  })

  test("the retired .server suffix is rejected, not emptied", () => {
    const result = zoneOf("lib/legacy.server.ts")
    expect(result.zone === "error" && result.reason).toContain('retired ".server" suffix')
  })

  test("the retired root backend.ts points at its new home", () => {
    const result = zoneOf("backend.ts")
    expect(result.zone === "error" && result.reason).toContain("backend/app.ts")
  })

  test("third-party packages are libraries, named by their node_modules segment", () => {
    expect(zoneOf("node_modules/pg/index.js")).toEqual({
      zone: "library",
      packageName: "pg",
      modulePath: "pg/index.js",
    })
    expect(zoneOf("node_modules/@scope/ui/index.js")).toEqual({
      zone: "library",
      packageName: "@scope/ui",
      modulePath: "@scope/ui/index.js",
    })
  })

  test("a symlinked workspace package is first-party: it classifies by its own declaration", () => {
    expect(zoneOf("node_modules/@ws/ui-kit/src/index.ts")).toEqual({
      zone: "library",
      packageName: "@ws/ui-kit",
      declared: "library",
    })
    expect(zoneOf("node_modules/@ws/db/src/index.ts").zone).toBe("backend")
  })

  test("a workspace package that declares no side is an error, named once for the package", () => {
    const result = zoneOf("node_modules/@ws/loose/src/index.ts")
    expect(result.zone).toBe("error")
    if (result.zone !== "error") return
    expect(result.package).toBe("@ws/loose")
    expect(result.reason).toContain('package "@ws/loose" is first-party code outside the app')
    expect(result.reason).toContain('"nifra": { "environment"')
    expect(result.reason).toContain('"packages": { "@ws/*": "backend" }')
    expect(result.reason).not.toContain("src/index.ts")
  })

  test("files passed as generated entries classify as generated", () => {
    const entry = write("app/build-entry.ts")
    expect(createZoneClassifier({ appRoot: app, generatedFiles: [entry] }).classify(entry)).toEqual(
      {
        zone: "generated",
      },
    )
  })

  test("a generated server manifest is generated wherever the build wrote it", () => {
    // It composes both halves of every route, so it imports frontend code by design.
    const manifest = buildManifest(
      ["index.tsx", "index.backend.ts"],
      () => async () => ({ default: null }) as unknown as RouteModule,
    )
    const source = generateServerManifest(manifest, {
      resolve: (file) => `../routes/${file}`,
      clientEntry: "/assets/entry.js",
    })
    const generated = write("app/backend/server-manifest.ts", source)
    expect(createZoneClassifier({ appRoot: app }).classify(generated)).toEqual({
      zone: "generated",
    })
    // A hand-written module of the same name is ordinary backend code.
    const handWritten = write("app/backend/nested/server-manifest.ts")
    expect(createZoneClassifier({ appRoot: app }).classify(handWritten)).toEqual({
      zone: "backend",
    })
  })
})

describe("app zone settings", () => {
  const configured = (zones: unknown) =>
    createZoneClassifier({ appRoot: app, zones: parseZoneConfig(zones, "test") })

  test("packages gives an undeclared package a side; a package's own declaration still wins", () => {
    const classifier = configured({ packages: { "@ws/*": "library", "@ws/db": "frontend" } })
    expect(classifier.classify(join(app, "node_modules/@ws/loose/src/index.ts"))).toEqual({
      zone: "library",
      packageName: "@ws/loose",
      declared: "library",
    })
    // @ws/db declares backend in its own package.json; the app's exact entry does not override it.
    expect(classifier.classify(join(app, "node_modules/@ws/db/src/index.ts")).zone).toBe("backend")
  })

  test("an exact name beats a prefix, and the longest prefix beats a shorter one", () => {
    const exact = configured({ packages: { "@ws/*": "library", "@ws/loose": "backend" } })
    expect(exact.classify(join(app, "node_modules/@ws/loose/src/index.ts")).zone).toBe("backend")
    const longest = configured({ packages: { "@*": "library", "@ws/lo*": "frontend" } })
    expect(longest.classify(join(app, "node_modules/@ws/loose/src/index.ts")).zone).toBe("frontend")
  })

  test("packages also marks a third-party package, which browserDenial then honors", () => {
    const classifier = configured({ packages: { pg: "backend" } })
    const pg = classifier.classify(join(app, "node_modules/pg/index.js"))
    expect(pg).toEqual({
      zone: "library",
      packageName: "pg",
      modulePath: "pg/index.js",
      declared: "backend",
    })
    expect(browserDenial(pg)).toContain("declares itself backend-only")
  })

  test("a configured folder is a zone folder, suffix rules included", () => {
    write("app/migrations/001-init.ts")
    write("app/migrations/seed/users.ts")
    write("app/migrations/view.frontend.tsx")
    write("app/ui-kit/Card.tsx")
    const classifier = configured({ backend: ["migrations/**"], frontend: ["./ui-kit/"] })
    expect(classifier.classify(join(app, "migrations/001-init.ts")).zone).toBe("backend")
    expect(classifier.classify(join(app, "migrations/seed/users.ts")).zone).toBe("backend")
    expect(classifier.classify(join(app, "ui-kit/Card.tsx")).zone).toBe("frontend")
    const misplaced = classifier.classify(join(app, "migrations/view.frontend.tsx"))
    expect(misplaced.zone === "error" && misplaced.reason).toContain("sits in migrations/")
    // Without the setting the same file is in no zone.
    expect(zoneOf("migrations/001-init.ts").zone).toBe("error")
  })

  test("the app's package.json is read when no setting is passed", () => {
    const own = join(root, "own-config")
    mkdirSync(join(own, "jobs"), { recursive: true })
    writeFileSync(join(own, "jobs", "nightly.ts"), "export {}\n")
    writeFileSync(
      join(own, "package.json"),
      JSON.stringify({ name: "own", nifra: { zones: { backend: ["jobs"] } } }),
    )
    expect(createZoneClassifier({ appRoot: own }).classify(join(own, "jobs/nightly.ts")).zone).toBe(
      "backend",
    )
  })

  test.each([
    [[], "must be an object"],
    [{ packges: {} }, 'unknown key "packges"'],
    [{ packages: { "@ws/*": "server" } }, "must be one of frontend, backend, shared, library"],
    [{ packages: { "a*b": "backend" } }, 'may use "*" only at its end'],
    [{ backend: "migrations" }, "must be an array"],
    [{ backend: ["migrations/*.ts"] }, "must be a plain folder path"],
    [{ backend: ["../outside"] }, 'may not contain ".."'],
    [{ backend: ["/abs"] }, "must be a folder relative to the app"],
    [{ shared: ["backend/util"] }, "inside backend/"],
    [{ backend: ["jobs"], frontend: ["jobs/ui"] }, "a folder has one side"],
  ] as const)("refuses %j", (zones, message) => {
    expect(() => parseZoneConfig(zones, "app/package.json")).toThrow(ZoneConfigError)
    expect(() => parseZoneConfig(zones, "app/package.json")).toThrow(message)
  })
})

describe("browserDenial", () => {
  test("backend zones never reach a browser", () => {
    expect(browserDenial(zoneOf("routes/index.backend.ts"))).toContain("backend half")
    expect(browserDenial(zoneOf("backend/db/client.ts"))).toContain("backend code")
  })

  test("browser zones and ordinary packages pass", () => {
    for (const path of ["routes/index.tsx", "frontend/Button.tsx", "shared/format.ts"]) {
      expect(browserDenial(zoneOf(path))).toBeUndefined()
    }
    expect(browserDenial(zoneOf("node_modules/@scope/ui/index.js"))).toBeUndefined()
  })

  test("server packages, backend declarations and driver subpaths are refused", () => {
    expect(browserDenial(zoneOf("node_modules/pg/index.js"))).toContain('"pg" is server code')
    expect(browserDenial(zoneOf("node_modules/flagged/index.js"))).toContain("backend-only")
    const drizzle = zoneOf("node_modules/drizzle-orm/index.js")
    expect(browserDenial(drizzle, "drizzle-orm")).toBeUndefined()
    expect(browserDenial(drizzle, "drizzle-orm/node-postgres")).toContain("database driver")
    write("app/node_modules/drizzle-orm/node-postgres/driver.js")
    expect(browserDenial(zoneOf("node_modules/drizzle-orm/node-postgres/driver.js"))).toBe(
      '"drizzle-orm/node-postgres" is a database driver entry',
    )
  })

  test("an unzoned file is refused with its reason", () => {
    expect(browserDenial(zoneOf("lib/helpers.ts"))).toContain("is in no zone")
  })
})

describe("importAllowed", () => {
  test.each([
    ["route-frontend", "frontend", true],
    ["route-frontend", "shared", true],
    ["route-frontend", "fn", true],
    ["route-frontend", "backend", false],
    ["route-frontend", "route-backend", false],
    ["frontend", "backend", false],
    ["backend", "frontend", false],
    ["backend", "route-frontend", false],
    ["route-backend", "backend", true],
    ["route-backend", "shared", true],
    ["backend", "library", true],
    ["shared", "shared", true],
    ["shared", "library", true],
    ["shared", "frontend", false],
    ["shared", "backend", false],
    ["generated", "route-backend", true],
  ] as const)("%s -> %s is %p", (from, to, allowed) => {
    expect(importAllowed(from, to)).toBe(allowed)
  })

  test("the refusal message names both files and the way out", () => {
    const message = importRuleMessage("frontend/a.tsx", "frontend", "backend/db.ts", "backend")
    expect(message).toContain("frontend/a.tsx")
    expect(message).toContain("backend/db.ts")
    expect(message).toContain("*.fn.ts")
    expect(message).toContain("import type")
  })
})
