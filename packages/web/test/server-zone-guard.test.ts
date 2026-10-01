import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildServer } from "../src/build.ts"
import { buildServerVite } from "../src/build-vite.ts"
import { formatUnsupportedBuiltins, unsupportedBuiltins } from "../src/internal/target-compat.ts"
import type { ClientModuleGraph, GraphImport } from "../src/module-graph.ts"

// The server build holds every first-party file to the zone rules and refuses a built-in its target
// cannot load. A refused build leaves no output behind. Temp apps live inside the workspace so
// `@nifrajs/*` imports resolve.
const TMP = `${import.meta.dir}/.tmp-server-zone-guard-`
let root: string

const write = (path: string, text: string): string => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

const build = (target?: "browser" | "node" | "bun") =>
  buildServer({
    routesDir: join(root, "routes"),
    serverEntry: join(root, "worker.ts"),
    outDir: join(root, "dist"),
    clientEntry: "/assets/entry.js",
    minify: false,
    ...(target === undefined ? {} : { target }),
  })

/** The build's rejection message; fails the test when the build passes. */
async function refusal(target?: "browser" | "node" | "bun"): Promise<string> {
  try {
    await build(target)
  } catch (error) {
    expect(existsSync(join(root, "dist")) ? readdirSync(join(root, "dist")) : []).toEqual([])
    return (error as Error).message
  }
  throw new Error("the build passed")
}

/** A route whose backend half calls `use` from `module`, so the bundle keeps the import. */
const routeUsing = (module: string) => {
  write("routes/index.tsx", "export default () => null\n")
  write(
    "routes/index.backend.ts",
    `import { use } from "${module}"\nexport const loader = () => ({ value: use() })\n`,
  )
}

beforeEach(() => {
  root = mkdtempSync(TMP)
  write(
    "worker.ts",
    'import { manifest, clientEntry } from "./server-manifest"\nexport default { manifest, clientEntry }\n',
  )
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("buildServer refuses", () => {
  test("a file in no zone, with the chain", async () => {
    write("lib/db.ts", "export const use = () => 1\n")
    routeUsing("../lib/db.ts")
    const message = await refusal("bun")
    expect(message).toContain("the server build breaks the zone rules")
    expect(message).toContain('"lib/db.ts" is in no zone')
  })

  test("backend code importing frontend code", async () => {
    write("frontend/format.ts", "export const format = (n: number) => String(n)\n")
    write(
      "backend/report.ts",
      'import { format } from "../frontend/format.ts"\nexport const use = () => format(1)\n',
    )
    routeUsing("../backend/report.ts")
    expect(await refusal("bun")).toContain("backend code may not import frontend code")
  })

  test("shared code importing a server built-in", async () => {
    write("shared/paths.ts", 'import { sep } from "node:path"\nexport const use = () => sep\n')
    routeUsing("../shared/paths.ts")
    expect(await refusal("bun")).toContain(
      'shared code runs on both sides, so it may not import "node:path"',
    )
  })

  test("a Node built-in an edge bundle keeps", async () => {
    write(
      "backend/files.ts",
      'import { readFileSync } from "node:fs"\nexport const use = () => readFileSync("x", "utf8")\n',
    )
    routeUsing("../backend/files.ts")
    const message = await refusal()
    expect(message).toContain("Node built-in(s) reached an edge server bundle: node:fs")
    expect(message).toContain("backend/files.ts")
  })

  test("a Bun built-in the node target cannot load", async () => {
    write(
      "backend/db.ts",
      'import { Database } from "bun:sqlite"\nexport const use = () => new Database(":memory:")\n',
    )
    routeUsing("../backend/db.ts")
    const message = await refusal("node")
    expect(message).toContain("Bun built-in(s) reached a Node server bundle: bun:sqlite")
    expect(message).toContain("backend/db.ts")
  })
})

test("the Vite server build refuses what the Bun one does", async () => {
  write("lib/db.ts", "export const use = () => 1\n")
  routeUsing("../lib/db.ts")
  const promise = buildServerVite({
    routesDir: join(root, "routes"),
    serverEntry: join(root, "worker.ts"),
    outDir: join(root, "dist"),
    clientEntry: "/assets/entry.js",
    target: "node",
    minify: false,
  })
  await expect(promise).rejects.toThrow('"lib/db.ts" is in no zone')
})

describe("buildServer builds", () => {
  test("backend built-ins on the target that has them, and shared code on both sides", async () => {
    write("shared/format.ts", "export const format = (n: number) => String(n)\n")
    write(
      "backend/db.ts",
      [
        'import { Database } from "bun:sqlite"',
        'import { format } from "../shared/format.ts"',
        'export const use = () => format(new Database(":memory:").query("select 1").all().length)',
        "",
      ].join("\n"),
    )
    routeUsing("../backend/db.ts")
    const { worker } = await build("bun")
    expect(existsSync(worker)).toBe(true)
  })
})

describe("unsupportedBuiltins", () => {
  const LIB = "node_modules/lib/llms.js"
  const graph = (
    builtin: GraphImport,
    options: { readonly ships?: boolean; readonly kept?: readonly string[] } = {},
  ): ClientModuleGraph => ({
    modules: {
      "worker.ts": { imports: [{ path: LIB, original: "lib" }] },
      [LIB]: { imports: [builtin] },
    },
    chunks: {
      "worker.js": {
        entryPoint: "worker.ts",
        modules: options.ships === false ? ["worker.ts"] : ["worker.ts", LIB],
        imports: options.kept ?? [],
      },
    },
  })
  const fsStatic: GraphImport = { path: "node:fs", original: "node:fs", external: true }
  const fsDynamic: GraphImport = { ...fsStatic, dynamic: true }
  const found = (g: ClientModuleGraph, target: "browser" | "node" | "bun" = "browser") => [
    ...unsupportedBuiltins(g, target, (id) => id),
  ]

  test("a dynamic import dead code dropped from the output is not refused", () => {
    expect(found(graph(fsDynamic))).toEqual([])
  })

  test("a module the bundler shook out is not refused", () => {
    expect(found(graph(fsStatic, { ships: false }))).toEqual([])
  })

  test("a dynamic import the output keeps is refused, naming its importer", () => {
    const result = unsupportedBuiltins(
      graph(fsDynamic, { kept: ["node:fs"] }),
      "browser",
      (id) => id,
    )
    expect([...result]).toEqual([["node:fs", [LIB]]])
    expect(formatUnsupportedBuiltins(result, "browser")).toBe(
      "[nifra/web] Node built-in(s) reached an edge server bundle: node:fs. " +
        `Imported by: ${LIB}. ` +
        "Move the import behind a Node/Bun target or replace it with an edge-compatible API.",
    )
  })

  test("a static import of an external built-in in a shipped module is refused: Bun stubs it", () => {
    expect(found(graph(fsStatic))).toEqual([["node:fs", [LIB]]])
  })

  test("a built-in the bundler polyfilled is not refused", () => {
    expect(found(graph({ path: "node:path", original: "node:path" }))).toEqual([])
  })

  test("without output evidence every module import counts", () => {
    const g = graph(fsDynamic)
    const chunk = g.chunks["worker.js"]
    if (chunk === undefined) throw new Error("fixture has no chunk")
    const { imports: _, ...bare } = chunk
    expect(found({ ...g, chunks: { "worker.js": bare } })).toEqual([["node:fs", [LIB]]])
  })

  test("the node target loads node: built-ins and the bun target loads all of them", () => {
    expect(found(graph(fsStatic, { kept: ["node:fs"] }), "node")).toEqual([])
    const bunOnly = graph({ path: "bun:sqlite", original: "bun:sqlite", external: true })
    expect(found(bunOnly, "node")).toEqual([["bun:sqlite", [LIB]]])
    expect(found(bunOnly, "bun")).toEqual([])
  })
})
