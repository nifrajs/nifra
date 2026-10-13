import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createExportedFileResolver,
  exportsTarget,
  splitBareSpecifier,
} from "../src/internal/workspace-packages.ts"
import { writeAppFile } from "./fixture-root.ts"

const created: string[] = []
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nifra-ws-packages-")))
  created.push(dir)
  mkdirSync(join(dir, ".git"))
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

describe("splitBareSpecifier", () => {
  test("splits a package name from its subpath", () => {
    expect(splitBareSpecifier("@team/kit")).toEqual(["@team/kit", "."])
    expect(splitBareSpecifier("@team/kit/contract")).toEqual(["@team/kit", "./contract"])
    expect(splitBareSpecifier("kit/a/b")).toEqual(["kit", "./a/b"])
  })

  test("a relative, absolute, imports-map or scheme specifier is not bare", () => {
    for (const specifier of ["./a", "../a", "/a", "#internal", "node:fs", "bun:test", "@/a"])
      expect(splitBareSpecifier(specifier)).toBeUndefined()
  })
})

describe("exportsTarget", () => {
  test("reads conditions in key order, taking bun, import and default", () => {
    const exports = { ".": { require: "./a.cjs", import: "./a.mjs", default: "./a.js" } }
    expect(exportsTarget(exports, ".")).toBe("./a.mjs")
    expect(exportsTarget({ ".": { node: { bun: "./n.ts" }, default: "./d.js" } }, ".")).toBe(
      "./d.js",
    )
    expect(exportsTarget({ ".": [{ worker: "./w.js" }, "./fallback.js"] }, ".")).toBe(
      "./fallback.js",
    )
  })

  test("takes types only when it names a TypeScript source", () => {
    expect(exportsTarget({ ".": { types: "./src/a.ts", default: "./dist/a.js" } }, ".")).toBe(
      "./src/a.ts",
    )
    expect(exportsTarget({ ".": { types: "./dist/a.d.ts", default: "./dist/a.js" } }, ".")).toBe(
      "./dist/a.js",
    )
  })

  test("a string or a conditions object is the root export alone", () => {
    expect(exportsTarget("./main.ts", ".")).toBe("./main.ts")
    expect(exportsTarget({ bun: "./main.ts" }, ".")).toBe("./main.ts")
    expect(exportsTarget("./main.ts", "./sub")).toBeUndefined()
  })

  test("the * pattern with the longest prefix wins; null excludes", () => {
    const exports = {
      "./*": "./src/*.ts",
      "./ops/*": "./src/operations/*.ts",
      "./ops/private/*": null,
    }
    expect(exportsTarget(exports, "./ops/users")).toBe("./src/operations/users.ts")
    expect(exportsTarget(exports, "./other")).toBe("./src/other.ts")
    expect(exportsTarget(exports, "./ops/private/key")).toBeNull()
    expect(exportsTarget(exports, "./ops/../../escape")).toBeUndefined()
    expect(exportsTarget({ "./a": "../outside.ts" }, "./a")).toBeUndefined()
  })
})

describe("createExportedFileResolver", () => {
  test("a workspace member resolves through exports, never outside the package", async () => {
    const root = scratch()
    writeAppFile(root, "package.json", json({ name: "root", workspaces: ["packages/*"] }))
    writeAppFile(
      root,
      "packages/kit/package.json",
      json({
        name: "@team/kit",
        exports: { "./contract": "./src/contract.ts", "./up": "./../x.ts" },
      }),
    )
    writeAppFile(root, "packages/kit/src/contract.ts", "export {}\n")
    const resolve = await createExportedFileResolver(join(root, "apps/web"))
    const from = join(root, "apps/web/src/app.ts")
    expect(resolve(from, "@team/kit/contract")).toEqual({
      path: join(root, "packages/kit/src/contract.ts"),
    })
    expect(resolve(from, "@team/kit/missing")).toEqual({
      package: "@team/kit",
      reason: '@team/kit does not export "./missing"',
    })
    expect(resolve(from, "@team/kit/up")).toEqual({
      package: "@team/kit",
      reason: '@team/kit does not export "./up"',
    })
    expect(resolve(from, "./local")).toBeUndefined()
  })

  test("a member without exports is probed from main, then index", async () => {
    const root = scratch()
    writeAppFile(root, "package.json", json({ name: "root", workspaces: ["packages/*"] }))
    writeAppFile(
      root,
      "packages/main/package.json",
      json({ name: "main-kit", main: "./lib/entry" }),
    )
    writeAppFile(root, "packages/main/lib/entry.ts", "export {}\n")
    writeAppFile(root, "packages/bare/package.json", json({ name: "bare-kit" }))
    writeAppFile(root, "packages/bare/index.ts", "export {}\n")
    writeAppFile(root, "packages/bare/deep/index.tsx", "export {}\n")
    const resolve = await createExportedFileResolver(root)
    const from = join(root, "src/app.ts")
    expect(resolve(from, "main-kit")).toEqual({ path: join(root, "packages/main/lib/entry.ts") })
    expect(resolve(from, "bare-kit")).toEqual({ path: join(root, "packages/bare/index.ts") })
    expect(resolve(from, "bare-kit/deep")).toEqual({
      path: join(root, "packages/bare/deep/index.tsx"),
    })
    expect(resolve(from, "bare-kit/none")).toEqual({
      package: "bare-kit",
      reason: "bare-kit/none resolves to ./none, which does not exist",
    })
  })

  test("a link out of node_modules is read; a registry install never is", async () => {
    const root = scratch()
    writeAppFile(root, "package.json", json({ name: "app" }))
    writeAppFile(root, "linked/package.json", json({ name: "linked-kit", exports: "./a.ts" }))
    writeAppFile(root, "linked/a.ts", "export {}\n")
    mkdirSync(join(root, "node_modules"))
    symlinkSync(join(root, "linked"), join(root, "node_modules/linked-kit"))
    writeAppFile(
      root,
      "node_modules/registry-kit/package.json",
      json({ name: "registry-kit", exports: "./a.ts" }),
    )
    writeAppFile(root, "node_modules/registry-kit/a.ts", "export {}\n")
    const resolve = await createExportedFileResolver(root)
    const from = join(root, "src/app.ts")
    expect(resolve(from, "linked-kit")).toEqual({ path: join(root, "linked/a.ts") })
    expect(resolve(from, "registry-kit")).toEqual({
      package: "registry-kit",
      reason: "registry-kit is installed from a registry, not a workspace package",
    })
    expect(resolve(from, "absent-kit")).toEqual({
      package: "absent-kit",
      reason: "absent-kit is not a workspace package and is not installed",
    })
  })
})
