import { afterAll, describe, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { snapshotContracts } from "../src/contracts.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

// The backend is imported by the contract-lock check, so fixtures live in the workspace where
// `@nifrajs/core` resolves.
const parent = createFixtureRoot("tmp-contract-visibility-")
afterAll(() => removeFixtureRoot(parent))

const CONTRACT = [
  'import { defineContract } from "@nifrajs/core/contract"',
  "export const users = defineContract({",
  '  list: { method: "GET", path: "/users" },',
  '  create: { method: "post", path: "/users" },',
  "})",
  "",
].join("\n")

const IMPLEMENTATION = [
  'import { implement } from "@nifrajs/core/contract"',
  'import { users } from "~/contract"',
  "export const createApp = (app?: Parameters<typeof implement>[2]) =>",
  "  implement(users, { list: () => [], create: () => ({}) }, app)",
  "",
].join("\n")

async function project(files: Record<string, string>, lock = true): Promise<string> {
  const root = createFixtureProject(parent, "app-")
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["./*"] } } }),
    "contract.ts": CONTRACT,
    "src/app.ts": IMPLEMENTATION,
    ...files,
  }
  for (const [path, content] of Object.entries(all)) writeAppFile(root, path, content)
  if (lock) await snapshotContracts(root)
  return root
}

async function findings(root: string) {
  return (await collectCheckResult(root, { lintsOnly: true })).diagnostics
    .filter((d) => d.code === "NF-C039")
    .map((d) => ({ at: `${d.file}:${d.line}`, severity: d.severity, message: d.message }))
}

describe("NF-C039", () => {
  test("an implemented contract the backend does not serve is named, operation by operation", async () => {
    const root = await project({
      "backend/app.ts":
        'import { server } from "@nifrajs/core"\nexport const backend = server().get("/health", () => "ok")\n',
    })
    const found = await findings(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.at).toBe("src/app.ts:4")
    expect(found[0]?.severity).toBe("warning")
    expect(found[0]?.message).toStartWith(
      "implement(users) serves 2 operation(s) that backend/app.ts does not: GET /users, POST /users.",
    )
  })

  test("served directly or under a group prefix, it is clean", async () => {
    const direct = await project({
      "backend/app.ts":
        'import { createApp } from "../src/app"\nexport const backend = createApp()\n',
    })
    expect(await findings(direct)).toEqual([])
    const grouped = await project({
      "backend/app.ts": [
        'import { server } from "@nifrajs/core"',
        'import { createApp } from "../src/app"',
        'export const backend = server().group("/api", (api) => createApp(api))',
        "",
      ].join("\n"),
    })
    expect(await findings(grouped)).toEqual([])
  })

  test("an operation counts as served only at one mount prefix shared by the whole contract", async () => {
    const contract = [
      'import { defineContract } from "@nifrajs/core/contract"',
      "export const users = defineContract({",
      '  list: { method: "GET", path: "/" },',
      '  read: { method: "GET", path: "/:id" },',
      "})",
      "",
    ].join("\n")
    const implementation = [
      'import { implement } from "@nifrajs/core/contract"',
      'import { users } from "~/contract"',
      "export const createApp = (app?: Parameters<typeof implement>[2]) =>",
      "  implement(users, { list: () => [], read: () => ({}) }, app)",
      "",
    ].join("\n")
    const unmounted = await project({
      "contract.ts": contract,
      "src/app.ts": implementation,
      "backend/app.ts": [
        'import { server } from "@nifrajs/core"',
        "export const backend = server()",
        '  .get("/health", () => "ok")',
        '  .get("/posts/:id", () => ({}))',
        "",
      ].join("\n"),
    })
    // `/health` could be `/` mounted there, but then `/health/:id` is missing: no prefix serves both.
    const found = await findings(unmounted)
    expect(found.map((f) => f.at)).toEqual(["src/app.ts:4"])
    expect(found[0]?.message).toStartWith(
      "implement(users) serves 1 operation(s) that backend/app.ts does not: GET /:id.",
    )

    const mounted = await project({
      "contract.ts": contract,
      "src/app.ts": implementation,
      "backend/app.ts": [
        'import { server } from "@nifrajs/core"',
        'import { createApp } from "../src/app"',
        "export const backend = server()",
        '  .get("/posts/:id", () => ({}))',
        '  .group("/users", (users) => createApp(users))',
        "",
      ].join("\n"),
    })
    expect(await findings(mounted)).toEqual([])
  })

  test("with no backend/app.ts, one finding counts what no gate sees", async () => {
    const root = await project({}, false)
    const found = await findings(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toStartWith(
      "2 contract operation(s) are implemented in source, but there is no backend/app.ts",
    )
  })

  test("a contract the scan cannot read is reported, never skipped; the API may pass through a module", async () => {
    const root = await project(
      {
        "lib/api.ts": 'export { implement, defineContract } from "@nifrajs/core/contract"\n',
        "src/app.ts": [
          'import { implement, defineContract } from "../lib/api"',
          "declare const make: () => Parameters<typeof implement>[0]",
          "const method = 'GET' as const",
          "export const a = implement(make(), {})",
          'export const b = implement(defineContract({ one: { method, path: "/one" } }), { one: () => 1 })',
          "",
        ].join("\n"),
      },
      false,
    )
    const found = await findings(root)
    // Nothing readable is left to count, so the missing backend adds no finding of its own.
    expect(found.map((f) => f.at)).toEqual(["src/app.ts:4", "src/app.ts:5"])
    expect(found[0]?.message).toContain(
      "the contract make() is not a defineContract({...}) the scan can read",
    )
    expect(found[1]?.message).toContain(
      'operation "one" has a method or path that is not a string literal',
    )
  })

  test("a nested package's implementation belongs to that package, not this one", async () => {
    const root = await project(
      {
        "src/app.ts": "export const implementation = 1\n",
        "examples/package.json": JSON.stringify({ name: "examples" }),
        "examples/contract-client.ts": IMPLEMENTATION.replace('"~/contract"', '"../contract"'),
      },
      false,
    )
    expect(await findings(root)).toEqual([])
  })

  describe("a contract in a workspace package", () => {
    const workspace = (implementation: string, backend: string): Promise<string> =>
      project(
        {
          "package.json": JSON.stringify({ name: "app", workspaces: ["packages/*"] }),
          "packages/contracts/package.json": JSON.stringify({
            name: "@team/contracts",
            exports: {
              "./contract": { types: "./src/contract.ts", default: "./dist/contract.js" },
              "./ops/*": "./src/ops/*.ts",
            },
          }),
          "packages/contracts/src/contract.ts": CONTRACT,
          "packages/contracts/src/ops/users.ts": CONTRACT,
          "node_modules/@vendor/contracts/package.json": JSON.stringify({
            name: "@vendor/contracts",
            exports: { "./contract": "./src/contract.ts" },
          }),
          "node_modules/@vendor/contracts/src/contract.ts": CONTRACT,
          "src/app.ts": IMPLEMENTATION.replace('"~/contract"', `"${implementation}"`),
          "backend/app.ts": [
            'import { server } from "@nifrajs/core"',
            `export const backend = server()${backend}`,
            "",
          ].join("\n"),
        },
        true,
      )
    const BOTH = '.get("/users", () => []).post("/users", () => ({}))'

    test("is read through the package's exports, conditions and * subpaths alike", async () => {
      for (const specifier of ["@team/contracts/contract", "@team/contracts/ops/users"]) {
        expect(await findings(await workspace(specifier, BOTH))).toEqual([])
        const found = await findings(await workspace(specifier, '.get("/users", () => [])'))
        expect(found).toHaveLength(1)
        expect(found[0]?.message).toStartWith(
          "implement(users) serves 1 operation(s) that backend/app.ts does not: POST /users.",
        )
      }
    })

    test("a package installed from a registry, or a subpath it does not export, is named as unreadable", async () => {
      const vendor = await findings(await workspace("@vendor/contracts/contract", BOTH))
      expect(vendor.map((f) => f.message)).toEqual([
        expect.stringContaining(
          'the contract users is imported from "@vendor/contracts/contract", which the scan cannot read: @vendor/contracts is installed from a registry, not a workspace package',
        ),
      ])
      const missing = await findings(await workspace("@team/contracts/missing", BOTH))
      expect(missing.map((f) => f.message)).toEqual([
        expect.stringContaining(
          'which the scan cannot read: @team/contracts does not export "./missing"',
        ),
      ])
    })
  })

  test("a project that implements no contract gets nothing", async () => {
    const root = await project(
      {
        "src/app.ts": "export const implementation = 1\n",
        "backend/app.ts":
          'import { server } from "@nifrajs/core"\nexport const backend = server().get("/health", () => "ok")\n',
      },
      true,
    )
    expect(await findings(root)).toEqual([])
  })
})
