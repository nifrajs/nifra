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
  declaredSide,
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

  test("a path inside another's folder overrides it, and a single file can be listed", () => {
    write("app/deck/server/mail.ts")
    write("app/deck/server/views/Preview.tsx")
    write("app/deck/server/mail.frontend.ts")
    write("app/deck/Panel.tsx")
    write("app/deck/env.ts")
    write("app/deck/env.tsx")
    write("app/deck/env.shared.ts")
    write("app/tools/seed.ts")
    const classifier = configured({
      frontend: ["deck", "deck/server/views"],
      backend: ["deck/server", "tools/seed.ts"],
      shared: ["deck/env.ts"],
    })
    expect(classifier.classify(join(app, "deck/Panel.tsx")).zone).toBe("frontend")
    expect(classifier.classify(join(app, "deck/server/mail.ts")).zone).toBe("backend")
    expect(classifier.classify(join(app, "deck/server/views/Preview.tsx")).zone).toBe("frontend")
    expect(classifier.classify(join(app, "deck/env.ts")).zone).toBe("shared")
    expect(classifier.classify(join(app, "tools/seed.ts")).zone).toBe("backend")
    // A listed file is not a folder: its name is no prefix for a sibling.
    expect(classifier.classify(join(app, "deck/env.tsx")).zone).toBe("frontend")
    const misplaced = configured({ backend: ["deck/env.shared.ts"] }).classify(
      join(app, "deck/env.shared.ts"),
    )
    expect(misplaced.zone === "error" && misplaced.reason).toContain(
      'is listed as backend in "nifra.zones"',
    )
    const against = configured({ frontend: ["deck"], backend: ["deck/server"] }).classify(
      join(app, "deck/server/mail.frontend.ts"),
    )
    expect(against.zone === "error" && against.reason).toContain(
      'sits in deck/server/, which "nifra.zones" lists as backend,',
    )
  })

  test("a module inside frontend/ or backend/ may be declared shared, by entry or by suffix", () => {
    write("app/frontend/lib/rates.ts")
    write("app/frontend/lib/rates.frontend.ts")
    write("app/frontend/lib/units.shared.ts")
    write("app/backend/lib/limits.shared.ts")
    write("app/backend/lib/jobs.frontend.ts")
    write("app/public/env.shared.js")
    const classifier = configured({ shared: ["frontend/lib/rates.ts"] })
    expect(classifier.classify(join(app, "frontend/lib/rates.ts")).zone).toBe("shared")
    expect(classifier.classify(join(app, "frontend/lib/units.shared.ts")).zone).toBe("shared")
    expect(classifier.classify(join(app, "backend/lib/limits.shared.ts")).zone).toBe("shared")
    // Only shared, the side both may import: a file still cannot cross to the other side.
    const crossed = classifier.classify(join(app, "backend/lib/jobs.frontend.ts"))
    expect(crossed.zone === "error" && crossed.reason).toContain(
      '".frontend" suffix says otherwise',
    )
    // public/ is served as it is, so nothing in it is code either side imports.
    expect(classifier.classify(join(app, "public/env.shared.js")).zone).toBe("error")
    expect(zoneOf("frontend/lib/rates.ts").zone).toBe("frontend")
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
    [{ backend: ["migrations/*.ts"] }, "must be a plain path"],
    [{ backend: ["../outside"] }, 'may not contain ".."'],
    [{ backend: ["/abs"] }, "must be a folder or file relative to the app"],
    [
      { frontend: ["backend/util"] },
      'inside backend/, which already has its own rules; only a "shared" entry',
    ],
    [{ shared: ["backend"] }, "inside backend/"],
    [{ shared: ["routes/util.ts"] }, "inside routes/"],
    [{ shared: ["public/env.js"] }, "inside public/"],
    [{ backend: ["jobs"], frontend: ["./jobs/"] }, "listed as both backend and frontend"],
  ] as const)("refuses %j", (zones, message) => {
    expect(() => parseZoneConfig(zones, "app/package.json")).toThrow(ZoneConfigError)
    expect(() => parseZoneConfig(zones, "app/package.json")).toThrow(message)
    try {
      parseZoneConfig(zones, "app/package.json")
    } catch (error) {
      expect(error instanceof ZoneConfigError && error.source).toBe("app/package.json")
    }
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

describe("per-entry package environments", () => {
  const json = (value: unknown): string => JSON.stringify(value)
  write(
    "packages/split/package.json",
    json({
      name: "@ws/split",
      type: "module",
      exports: {
        ".": { browser: "./src/browser.ts", default: "./src/index.ts" },
        "./react": "./src/react.ts",
        "./schema": "./src/schema.ts",
        "./components/*": "./src/components/*.ts",
        "./extra": "./src/extra.ts",
      },
      nifra: {
        environment: {
          ".": "backend",
          "./react": "frontend",
          "./schema": "library",
          "./components/*": "frontend",
          "./components/server-*": "backend",
        },
      },
    }),
  )
  write(
    "packages/split/src/index.ts",
    'import { db } from "./db.ts"\nexport * from "./util.ts"\nexport const root = db\n',
  )
  write("packages/split/src/browser.ts", "export const root = 0\n")
  write("packages/split/src/db.ts", "export const db = 1\n")
  write("packages/split/src/util.ts", "export const util = 1\n")
  write(
    "packages/split/src/react.ts",
    '// import { db } from "./db.ts"\nimport { util } from "./util.js"\nexport const lazy = () => import("./lazy.ts")\nexport const view = util\nimport "./styles.css"\nexport const worker = new URL("./worker.ts", import.meta.url)\n',
  )
  write("packages/split/src/react.d.ts", "export declare const view: number\n")
  write("packages/split/src/lazy.ts")
  write("packages/split/src/worker.ts")
  write("packages/split/src/styles.css", '@import "./base.css";\n.x { background: url(img.png) }\n')
  write("packages/split/src/base.css", "/* @import './orphan.css'; */\n")
  write("packages/split/src/img.png", "")
  write("packages/split/src/orphan.css", "")
  write("packages/split/src/schema.ts")
  write("packages/split/src/components/Button.ts")
  write("packages/split/src/components/server-Table.ts")
  write("packages/split/src/extra.ts")
  write("packages/split/src/orphan.ts")
  write(
    "packages/same/package.json",
    json({
      name: "@ws/same",
      exports: { ".": "./index.js", "./react": "./index.js" },
      nifra: { environment: { ".": "backend", "./react": "frontend" } },
    }),
  )
  write("packages/same/index.js")
  write(
    "packages/bad/package.json",
    json({ name: "@ws/bad", nifra: { environment: { react: "frontend" } } }),
  )
  write("packages/bad/index.js")
  write(
    "app/node_modules/mapped/package.json",
    json({
      name: "mapped",
      main: "lib/index.js",
      nifra: { environment: { ".": "library", "./server": "backend" } },
    }),
  )
  write("app/node_modules/mapped/lib/index.js", 'module.exports = require("./shared.js")\n')
  write("app/node_modules/mapped/lib/shared.js")
  write("app/node_modules/mapped/server.js", 'require("./lib/secret.js")\n')
  write("app/node_modules/mapped/lib/secret.js")
  write(
    "app/node_modules/nested/package.json",
    json({ name: "nested", nifra: { environment: "backend" } }),
  )
  write("app/node_modules/nested/dist/esm/package.json", json({ type: "module" }))
  write("app/node_modules/nested/dist/esm/index.js")
  for (const name of ["split", "same", "bad"])
    symlinkSync(join(root, "packages", name), join(app, `node_modules/@ws/${name}`))

  const entries = createZoneClassifier({ appRoot: app })
  const split = (path: string): string => join(app, "node_modules/@ws/split/src", path)
  const byPath = (path: string): Classification => entries.classify(split(path))

  test("a file takes the side of every mapped entry that reaches it, under any condition", () => {
    expect(byPath("react.ts")).toEqual({ zone: "frontend" })
    expect(byPath("lazy.ts")).toEqual({ zone: "frontend" })
    for (const path of ["worker.ts", "styles.css", "base.css", "img.png"])
      expect({ path, zone: byPath(path).zone }).toEqual({ path, zone: "frontend" })
    expect(byPath("orphan.css").zone).toBe("error")
    expect(byPath("db.ts")).toEqual({ zone: "backend" })
    expect(byPath("browser.ts")).toEqual({ zone: "backend" })
    expect(byPath("schema.ts")).toEqual({
      zone: "library",
      packageName: "@ws/split",
      declared: "library",
    })
    // The frontend and backend entries both reach it, so either side may load it.
    expect(byPath("util.ts")).toEqual({
      zone: "library",
      packageName: "@ws/split",
      declared: "library",
    })
    expect(byPath("components/Button.ts")).toEqual({ zone: "frontend" })
    expect(byPath("components/server-Table.ts")).toEqual({ zone: "backend" })
  })

  test("a file no mapped entry reaches is an error, naming the entries the map leaves out", () => {
    for (const path of ["orphan.ts", "extra.ts"]) {
      const result = byPath(path)
      expect(result.zone).toBe("error")
      expect(result.zone === "error" && result.reason).toContain(
        "no mapped entry reaches this file",
      )
      expect(result.zone === "error" && result.reason).toContain('the map leaves out "./extra"')
    }
  })

  test("an import is decided by the entry it names", () => {
    const root = entries.classify(split("index.ts"), "@ws/split")
    expect(root).toEqual({ zone: "backend", packageName: "@ws/split", entry: "." })
    expect(browserDenial(root)).toBe('package "@ws/split" declares its "." entry backend-only')
    const react = entries.classify(split("react.ts"), "@ws/split/react")
    expect(react).toEqual({ zone: "frontend", packageName: "@ws/split", entry: "./react" })
    expect(browserDenial(react)).toBeUndefined()
    expect(
      entries.classify(split("components/Button.ts"), "@ws/split/components/Button").zone,
    ).toBe("frontend")
    expect(
      entries.classify(split("components/server-Table.ts"), "@ws/split/components/server-Table")
        .zone,
    ).toBe("backend")
    expect(entries.classify(split("schema.ts"), "@ws/split/schema")).toEqual({
      zone: "library",
      packageName: "@ws/split",
      declared: "library",
      entry: "./schema",
    })
    // An editor resolves the entry to its declaration file, which is types only.
    expect(entries.classify(split("react.d.ts"), "@ws/split/react").zone).toBe("frontend")
  })

  test("an entry the map leaves out is an error when imported", () => {
    const extra = entries.classify(split("extra.ts"), "@ws/split/extra")
    expect(extra).toMatchObject({ zone: "error", entry: "./extra" })
    expect(extra.zone === "error" && extra.reason).toContain(
      '"@ws/split/extra" names the "./extra" entry of package "@ws/split"',
    )
  })

  test("a file the named entry does not reach is judged by its path", () => {
    // An alias that points the frontend entry's name at backend code.
    expect(entries.classify(split("db.ts"), "@ws/split/react")).toEqual({ zone: "backend" })
  })

  test("two entries sharing one file keep their own sides", () => {
    const file = join(app, "node_modules/@ws/same/index.js")
    expect(entries.classify(file)).toEqual({
      zone: "library",
      packageName: "@ws/same",
      declared: "library",
    })
    expect(entries.classify(file, "@ws/same").zone).toBe("backend")
    expect(entries.classify(file, "@ws/same/react").zone).toBe("frontend")
    expect(entries.classify(file, "@ws/same").zone).toBe("backend")
  })

  test("a third-party package without exports maps main and its subpath files", () => {
    const mapped = (path: string): string => join(app, "node_modules/mapped", path)
    expect(entries.classify(mapped("lib/shared.js"))).toMatchObject({ declared: "library" })
    const server = entries.classify(mapped("server.js"))
    expect(server).toEqual({
      zone: "library",
      packageName: "mapped",
      modulePath: "mapped/server.js",
      declared: "backend",
    })
    expect(entries.classify(mapped("lib/secret.js"))).toMatchObject({ declared: "backend" })
    expect(browserDenial(entries.classify(mapped("server.js"), "mapped/server"))).toBe(
      'package "mapped" declares its "./server" entry backend-only',
    )
    expect(entries.classify(mapped("package.json"), "mapped/other")).toMatchObject({
      zone: "error",
      entry: "./other",
    })
  })

  test("a third-party package is read from its own manifest, past a nested one", () => {
    expect(entries.classify(join(app, "node_modules/nested/dist/esm/index.js"))).toMatchObject({
      declared: "backend",
    })
  })

  test("an invalid map is an error for the package, naming its manifest and key", () => {
    const result = entries.classify(join(app, "node_modules/@ws/bad/index.js"))
    expect(result).toMatchObject({ zone: "error", package: "@ws/bad" })
    expect(result.zone === "error" && result.reason).toContain(
      'package.json "nifra.environment": key "react" must be "." or a subpath starting with "./"',
    )
  })

  test("a map outranks the app's package defaults", () => {
    const configured = createZoneClassifier({
      appRoot: app,
      zones: parseZoneConfig({ packages: { "@ws/*": "library" } }, "test"),
    })
    expect(configured.classify(split("db.ts")).zone).toBe("backend")
  })

  test.each([
    ["backend", "pkg", "backend"],
    [{ ".": "backend", "./react": "frontend" }, "pkg/react", "frontend"],
    [{ ".": "backend", "./*": "library", "./ui/*": "frontend" }, "pkg/ui/x", "frontend"],
    [{ ".": "backend" }, "pkg/react", undefined],
    [{ ".": "backend", "./react": "frontend" }, "pkg/react?raw#x", "frontend"],
    [{ ".": "backend", "./react": "frontend" }, "pkg/react#x?y", "frontend"],
    // A long run of `#` before a line break: the query/hash cut takes the first one.
    [{ ".": "backend", "./react": "frontend" }, `pkg/react${"#".repeat(20_000)}\n`, "frontend"],
    [{ ".": "server" }, "pkg", undefined],
    ["server", "pkg", undefined],
  ] as const)("declaredSide(%j, %s) is %s", (environment, specifier, side) => {
    expect(declaredSide(environment, specifier)).toBe(side)
  })
})

/**
 * A frontend entry that only types against a backend file must not make it frontend too: the two
 * owners would read as `library`, and a browser import of the file by path would pass.
 */
describe("type-only imports grant no entry ownership", () => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "@ws/typed",
      exports: { ".": "./server.ts", "./browser": "./browser.ts" },
      nifra: { environment: { ".": "backend", "./browser": "frontend" } },
    }),
    "server.ts": [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "valueDefault",
      "sideEffect",
      "named",
      "mixed",
    ]
      .map((name) => `import "./${name}.ts"`)
      .join("\n"),
    "browser.ts": [
      'import type { A } from "./a.ts"',
      'import type B from "./b.ts"',
      'import type * as C from "./c.ts"',
      'export type { D } from "./d.ts"',
      'export type * from "./e.ts"',
      'import { type F, type G as H, } from "./f.ts"',
      'export { type G } from "./g.ts"',
      "import type {",
      "  H,",
      '} from "./h.ts"',
      'import type from "./valueDefault.ts"',
      'import {} from "./sideEffect.ts"',
      'import { type as named } from "./named.ts"',
      'import M, { type T } from "./mixed.ts"',
    ].join("\n"),
  }
  for (const [path, text] of Object.entries(files)) write(`packages/typed/${path}`, text)
  for (const name of ["a", "b", "c", "d", "e", "f", "g", "h"]) write(`packages/typed/${name}.ts`)
  for (const name of ["valueDefault", "sideEffect", "named", "mixed"])
    write(`packages/typed/${name}.ts`)
  const typedApp = join(root, "typed-app")
  write("typed-app/package.json", JSON.stringify({ name: "typed-app" }))
  const classifier = createZoneClassifier({ appRoot: typedApp })
  const zoneOf = (name: string): string =>
    classifier.classify(join(root, "packages/typed", `${name}.ts`)).zone

  test.each(["a", "b", "c", "d", "e", "f", "g", "h"])("%s.ts stays backend", (name) => {
    expect(zoneOf(name)).toBe("backend")
    expect(browserDenial(classifier.classify(join(root, "packages/typed", `${name}.ts`)))).toBe(
      "it is backend code",
    )
  })

  test.each([
    "valueDefault",
    "sideEffect",
    "named",
    "mixed",
  ])("%s.ts is loaded at runtime, so both entries own it", (name) => {
    expect(zoneOf(name)).toBe("library")
  })
})
