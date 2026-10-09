import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createSpecifierResolver, parseJsonc } from "../src/internal/project-specifiers.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A project on disk; returns its real root, since the resolver answers with real paths. */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nifra-specifiers-")))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const tsconfig = (compilerOptions: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, compilerOptions })

describe("parseJsonc", () => {
  test("reads comments and trailing commas, and leaves strings alone", () => {
    expect(
      parseJsonc(
        '\uFEFF{\n  // a comment\n  "a": "http://x//y", /* block */\n  "b": [1, 2,],\n  "c": "a,]",\n}\n',
      ),
    ).toEqual({ a: "http://x//y", b: [1, 2], c: "a,]" })
  })

  test("rejects what is not JSON", () => {
    expect(() => parseJsonc("{ a: 1 }")).toThrow()
  })
})

describe("relative and absolute specifiers", () => {
  test("probe the file, its source for a .js name, an extension, a zone suffix and an index", () => {
    const root = project({
      "a.ts": "",
      "b.tsx": "",
      "lib/index.ts": "",
      "calendar.shared.ts": "",
      "esm.ts": "",
      "data.json": "{}",
      "routes/x.tsx": "",
    })
    const resolve = createSpecifierResolver()
    const from = join(root, "routes/x.tsx")
    expect(resolve(from, "../a")).toBe(join(root, "a.ts"))
    expect(resolve(from, "../b")).toBe(join(root, "b.tsx"))
    expect(resolve(from, "../lib")).toBe(join(root, "lib/index.ts"))
    expect(resolve(from, "../calendar.shared")).toBe(join(root, "calendar.shared.ts"))
    expect(resolve(from, "../esm.js")).toBe(join(root, "esm.ts"))
    expect(resolve(from, "../data.json")).toBe(join(root, "data.json"))
    expect(resolve(from, join(root, "a.ts"))).toBe(join(root, "a.ts"))
    expect(resolve(from, "../missing")).toBeUndefined()
  })

  test("answer with the real path, and never with a file under node_modules", () => {
    const root = project({ "real/b.ts": "", "node_modules/dep/index.ts": "", "x.ts": "" })
    symlinkSync(join(root, "real"), join(root, "link"), "dir")
    const resolve = createSpecifierResolver()
    expect(resolve(join(root, "x.ts"), "./link/b")).toBe(join(root, "real/b.ts"))
    expect(resolve(join(root, "x.ts"), "./node_modules/dep")).toBeUndefined()
  })
})

describe("tsconfig paths and baseUrl", () => {
  test("a `*` alias maps onto the project, and a bare package stays unresolved", () => {
    const root = project({
      "tsconfig.json": tsconfig({ paths: { "~/*": ["./*"] } }),
      "lib/fmt.ts": "",
      "server/session.ts": "",
      "routes/index.tsx": "",
    })
    const resolve = createSpecifierResolver()
    const from = join(root, "routes/index.tsx")
    expect(resolve(from, "~/lib/fmt")).toBe(join(root, "lib/fmt.ts"))
    expect(resolve(from, "~/server/session")).toBe(join(root, "server/session.ts"))
    expect(resolve(from, "react")).toBeUndefined()
    expect(resolve(from, "~/missing")).toBeUndefined()
  })

  test("the longest prefix wins, an exact pattern beats a wildcard, and targets are tried in order", () => {
    const root = project({
      "tsconfig.json": tsconfig({
        paths: {
          "@app/*": ["./src/*"],
          "@app/ui/*": ["./missing/*", "./ui/*"],
          "@app/config": ["./config/main.ts"],
        },
      }),
      "src/ui/button.ts": "",
      "ui/button.ts": "",
      "config/main.ts": "",
      "x.ts": "",
    })
    const resolve = createSpecifierResolver()
    const from = join(root, "x.ts")
    expect(resolve(from, "@app/ui/button")).toBe(join(root, "ui/button.ts"))
    expect(resolve(from, "@app/config")).toBe(join(root, "config/main.ts"))
  })

  test("paths resolve against baseUrl when set, else against the config that defines them", () => {
    const root = project({
      "tsconfig.base.json": tsconfig({ paths: { "$lib/*": ["./shared/*"] } }),
      "app/tsconfig.json": JSON.stringify({ extends: "../tsconfig.base" }),
      "app/based/tsconfig.json": tsconfig(
        { baseUrl: "./src", paths: { "#x/*": ["./x/*"] } },
        { extends: "../../tsconfig.base.json" },
      ),
      "shared/util.ts": "",
      "app/based/src/x/y.ts": "",
      "app/based/src/plain.ts": "",
      "app/based/page.ts": "",
      "app/page.ts": "",
    })
    const resolve = createSpecifierResolver()
    expect(resolve(join(root, "app/page.ts"), "$lib/util")).toBe(join(root, "shared/util.ts"))
    const based = join(root, "app/based/page.ts")
    expect(resolve(based, "#x/y")).toBe(join(root, "app/based/src/x/y.ts"))
    expect(resolve(based, "plain")).toBe(join(root, "app/based/src/plain.ts"))
  })

  test("extends follows a package in node_modules, its tsconfig field, and arrays, without looping", () => {
    const root = project({
      "node_modules/@scope/base/tsconfig.json": tsconfig({ paths: { "@one/*": ["./*"] } }),
      "node_modules/fielded/package.json": JSON.stringify({ tsconfig: "./configs/app.json" }),
      "node_modules/fielded/configs/app.json": tsconfig({ paths: { "@two/*": ["./*"] } }),
      "a/tsconfig.json": JSON.stringify({ extends: "@scope/base" }),
      "b/tsconfig.json": JSON.stringify({ extends: ["@scope/base", "fielded"] }),
      "c/tsconfig.json": JSON.stringify({ extends: "./tsconfig.json" }),
      "a/x.ts": "",
      "b/x.ts": "",
      "c/x.ts": "",
    })
    const resolve = createSpecifierResolver()
    // A path inside the package directory is under node_modules, so it never counts as project code.
    expect(resolve(join(root, "a/x.ts"), "@one/tsconfig.json")).toBeUndefined()
    expect(resolve(join(root, "b/x.ts"), "@two/package.json")).toBeUndefined()
    expect(resolve(join(root, "c/x.ts"), "anything")).toBeUndefined()
  })

  test("the nearest tsconfig governs a file", () => {
    const root = project({
      "tsconfig.json": tsconfig({ paths: { "~/*": ["./root/*"] } }),
      "app/tsconfig.json": tsconfig({ paths: { "~/*": ["./*"] } }),
      "root/fmt.ts": "",
      "app/fmt.ts": "",
      "app/routes/x.tsx": "",
      "other/x.ts": "",
    })
    const resolve = createSpecifierResolver()
    expect(resolve(join(root, "app/routes/x.tsx"), "~/fmt")).toBe(join(root, "app/fmt.ts"))
    expect(resolve(join(root, "other/x.ts"), "~/fmt")).toBe(join(root, "root/fmt.ts"))
  })

  test("a malformed tsconfig resolves no alias", () => {
    const root = project({ "tsconfig.json": "{ paths", "lib/fmt.ts": "", "x.ts": "" })
    expect(createSpecifierResolver()(join(root, "x.ts"), "~/lib/fmt")).toBeUndefined()
  })
})

describe("package.json imports", () => {
  test("exact and pattern keys, the bun/import/default conditions in key order, and the nearest scope", () => {
    const root = project({
      "package.json": JSON.stringify({
        imports: {
          "#lib/*": "./lib/*.ts",
          "#fmt": { node: "./node-only.ts", import: "./lib/fmt.ts", default: "./lib/other.ts" },
          "#nodeOnly": { node: "./node-only.ts" },
          "#dep": "some-package",
          "#first": [{ browser: "./b.ts" }, "./lib/fmt.ts"],
        },
      }),
      "lib/fmt.ts": "",
      "lib/other.ts": "",
      "node-only.ts": "",
      "nested/package.json": JSON.stringify({ imports: { "#fmt": "./own.ts" } }),
      "nested/own.ts": "",
      "x.ts": "",
    })
    const resolve = createSpecifierResolver()
    const from = join(root, "x.ts")
    expect(resolve(from, "#lib/fmt")).toBe(join(root, "lib/fmt.ts"))
    expect(resolve(from, "#fmt")).toBe(join(root, "lib/fmt.ts"))
    expect(resolve(from, "#nodeOnly")).toBeUndefined()
    expect(resolve(from, "#dep")).toBeUndefined()
    expect(resolve(from, "#first")).toBe(join(root, "lib/fmt.ts"))
    expect(resolve(from, "#missing")).toBeUndefined()
    expect(resolve(join(root, "nested/y.ts"), "#fmt")).toBe(join(root, "nested/own.ts"))
  })
})

describe("respell", () => {
  test("rewrites an alias through the same alias, in the same style, or not at all", () => {
    const root = project({
      "tsconfig.json": tsconfig({
        paths: { "~/*": ["./*"], "@app/*": ["./src/*"], "@app/ui/*": ["./ui/*"] },
      }),
      "package.json": JSON.stringify({
        imports: { "#lib/*": "./lib/*.ts", "#db": "./db/index.ts" },
      }),
      "lib/fmt.ts": "",
      "lib/index.ts": "",
      "src/money.ts": "",
      "esm.ts": "",
      "db/index.ts": "",
      "x.ts": "",
    })
    const { respell } = createSpecifierResolver()
    const from = join(root, "x.ts")
    const at = (path: string) => join(root, path)
    expect(respell(from, "~/lib/fmt", at("shared/lib/fmt.ts"))).toBe("~/shared/lib/fmt")
    expect(respell(from, "~/lib/fmt.ts", at("shared/lib/fmt.ts"))).toBe("~/shared/lib/fmt.ts")
    expect(respell(from, "~/lib", at("shared/lib/index.ts"))).toBe("~/shared/lib")
    expect(respell(from, "~/esm.js", at("shared/esm.ts"))).toBe("~/shared/esm.js")
    expect(respell(from, "@app/money", at("src/shared/money.ts"))).toBe("@app/shared/money")
    // No target of `@app/*` covers it, and a longer pattern would claim the other spelling.
    expect(respell(from, "@app/money", at("frontend/src/money.ts"))).toBeUndefined()
    expect(respell(from, "@app/money", at("src/ui/money.ts"))).toBeUndefined()
    expect(respell(from, "#lib/fmt", at("lib/text/fmt.ts"))).toBe("#lib/text/fmt")
    expect(respell(from, "#lib/fmt", at("shared/lib/fmt.ts"))).toBeUndefined()
    expect(respell(from, "#db", at("backend/db/index.ts"))).toBeUndefined()
    expect(respell(from, "./lib/fmt", at("shared/lib/fmt.ts"))).toBeUndefined()
    expect(respell(from, "react", at("shared/lib/fmt.ts"))).toBeUndefined()
  })

  test("a baseUrl name stays one, and only below baseUrl", () => {
    const root = project({
      "tsconfig.json": tsconfig({ baseUrl: "./src" }),
      "src/plain.ts": "",
      "x.ts": "",
    })
    const { respell } = createSpecifierResolver()
    const from = join(root, "x.ts")
    expect(respell(from, "plain", join(root, "src/sub/plain.ts"))).toBe("sub/plain")
    expect(respell(from, "plain", join(root, "src2/plain.ts"))).toBeUndefined()
  })
})
