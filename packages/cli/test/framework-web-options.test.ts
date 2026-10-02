import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assertFrameworkOptionsEdgeExported, assertNoShadowedPages } from "../src/cli.ts"
import { buildRouteTable } from "../src/introspect.ts"
import { type LoadedApp, loadApp, type NifraFramework } from "../src/load.ts"
import { runRuleRegistry } from "../src/rules/index.ts"
import { pageRules, readStaticApiPrefix } from "../src/rules/pages.ts"
import {
  frameworkMountPaths,
  frameworkOptionImports,
  frameworkWebAppOptions,
} from "../src/web-app-options.ts"
import { createFixtureProject, createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"
import { projectFacts } from "./rule-facts.ts"

// backend/framework.ts can set the `createWebApp` options a CLI-run app needs (`apiPrefix`, `apiStrip`,
// `mounts`, `csp`, `nonce`); every command forwards the same set, and a page under a mount is refused
// by the build and by `nifra check`.

const root = createFixtureRoot("tmp-framework-options-")
afterAll(() => removeFixtureRoot(root))

const adapterSource = [
  "export const adapter = { renderToStream: () => new ReadableStream(), hydrationHead: () => '' }",
  'export const clientModule = "@nifrajs/web-react/client"',
]

function project(files: Record<string, string>): string {
  const dir = createFixtureProject(root, "app-")
  mkdirSync(join(dir, "routes"), { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}

const fw = (fields: Partial<NifraFramework>): NifraFramework =>
  ({ adapter: {}, clientModule: "x", ...fields }) as NifraFramework

describe("loadApp validates the forwarded fields", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["export const apiPrefix = 42", "`apiPrefix` must be"],
    ["export const apiStrip = 'yes'", "`apiStrip` must be a boolean"],
    ["export const mounts = { path: '/a' }", "`mounts` must be an array"],
    ["export const csp = 'default-src self'", "`csp` must be the policy"],
    ["export const nonce = 'abc'", "`nonce` must be a nonce resolver function"],
    // A misspelled trust declaration must not quietly build an edge app with no caller address.
    ["export const clientIp = 'cf-connecting-ip'", '`clientIp` must be "platform"'],
  ]
  for (const [line, message] of cases) {
    test(line, async () => {
      const dir = project({
        "backend/framework.ts": [...adapterSource, line].join("\n"),
        "routes/index.tsx": "export default () => null\n",
      })
      await expect(loadApp(dir)).rejects.toThrow(message)
    })
  }

  test("well-formed fields load and reach the framework object", async () => {
    const dir = project({
      "backend/framework.ts": [
        ...adapterSource,
        'export const apiPrefix = "/rpc"',
        "export const apiStrip = true",
      ].join("\n"),
      "routes/index.tsx": "export default () => null\n",
    })
    const app = await loadApp(dir)
    expect(app.framework.apiPrefix).toBe("/rpc")
    expect(app.framework.apiStrip).toBe(true)
  })
})

describe("forwarding helpers", () => {
  test("frameworkWebAppOptions forwards use, the backend and every set field, nothing else", () => {
    const use = () => {}
    const mounts = [{ path: "/hooks", app: { fetch: () => new Response() } }]
    const options = frameworkWebAppOptions(fw({ use, apiPrefix: "/rpc", apiStrip: true, mounts }), {
      routes: () => [],
    })
    expect(Object.keys(options).sort()).toEqual(["api", "apiPrefix", "apiStrip", "mounts", "use"])
    expect(options.apiPrefix).toBe("/rpc")
    expect(options.mounts).toBe(mounts)
    expect(frameworkWebAppOptions(fw({}), undefined)).toEqual({})
  })

  test("frameworkMountPaths: each mount, plus the backend at apiPrefix when a backend exists", () => {
    const mounts = [{ path: "/hooks", app: { fetch: () => new Response() } }]
    expect(frameworkMountPaths(fw({ mounts }), true)).toEqual(["/hooks", "/api"])
    expect(frameworkMountPaths(fw({ mounts }), false)).toEqual(["/hooks"])
    expect(frameworkMountPaths(fw({ apiPrefix: "" }), true)).toEqual([])
    expect(frameworkMountPaths(fw({ apiPrefix: "/rpc" }), true)).toEqual(["/rpc"])
  })

  test("frameworkOptionImports maps each set field to the framework file", () => {
    expect(frameworkOptionImports(fw({}), "/a/backend/framework.ts")).toEqual({})
    expect(
      frameworkOptionImports(fw({ apiPrefix: "", csp: {} as never }), "/a/backend/framework.ts"),
    ).toEqual({
      optionImports: { apiPrefix: "/a/backend/framework.ts", csp: "/a/backend/framework.ts" },
    })
  })
})

describe("assertFrameworkOptionsEdgeExported", () => {
  test("a field set only in nifra.config.ts is refused, naming it", async () => {
    const dir = project({ "backend/framework.ts": adapterSource.join("\n") })
    await expect(
      assertFrameworkOptionsEdgeExported(
        fw({ apiPrefix: "/rpc" }),
        join(dir, "nifra.config.ts"),
        join(dir, "backend/framework.ts"),
      ),
    ).rejects.toThrow("`apiPrefix` is exported from")
  })

  test("a field defined separately with a different value is refused", async () => {
    const dir = project({
      "backend/framework.ts": [...adapterSource, 'export const apiPrefix = "/one"'].join("\n"),
    })
    await expect(
      assertFrameworkOptionsEdgeExported(
        fw({ apiPrefix: "/two" }),
        join(dir, "nifra.config.ts"),
        join(dir, "backend/framework.ts"),
      ),
    ).rejects.toThrow('export { apiPrefix } from "./backend/framework.ts"')
  })

  test("the same value (a re-export) passes; a single-file app and an unset field are no-ops", async () => {
    const dir = project({
      "backend/framework.ts": [...adapterSource, 'export const apiPrefix = "/rpc"'].join("\n"),
    })
    await assertFrameworkOptionsEdgeExported(
      fw({ apiPrefix: "/rpc" }),
      join(dir, "nifra.config.ts"),
      join(dir, "backend/framework.ts"),
    )
    await assertFrameworkOptionsEdgeExported(
      fw({ apiPrefix: "/x" }),
      "/a/backend/framework.ts",
      "/a/backend/framework.ts",
    )
    await assertFrameworkOptionsEdgeExported(
      fw({}),
      "/a/nifra.config.ts",
      "/a/backend/framework.ts",
    )
  })
})

describe("nifra build refuses a page under a mount", () => {
  const loaded = (dir: string, fields: Partial<NifraFramework>, backend: unknown): LoadedApp =>
    ({
      cwd: dir,
      configPath: join(dir, "backend/framework.ts"),
      routesDir: join(dir, "routes"),
      outDir: join(dir, "dist"),
      framework: fw(fields),
      resolvedPlugins: { vitePlugins: [], clientPlugins: [], serverPlugins: [] },
      backend,
    }) as LoadedApp

  test("a page under the backend's default prefix blocks the build", () => {
    const dir = project({ "routes/api/report.tsx": "export default () => null\n" })
    expect(() => assertNoShadowedPages(loaded(dir, {}, {}))).toThrow(
      "build blocked: 1 page route can never render",
    )
  })

  test("no backend, an empty prefix, or a page outside the prefix builds", () => {
    const dir = project({ "routes/api/report.tsx": "export default () => null\n" })
    expect(() => assertNoShadowedPages(loaded(dir, {}, undefined))).not.toThrow()
    expect(() => assertNoShadowedPages(loaded(dir, { apiPrefix: "" }, {}))).not.toThrow()
    expect(() => assertNoShadowedPages(loaded(dir, { apiPrefix: "/rpc" }, {}))).not.toThrow()
  })

  test("a page under a configured mount blocks the build", () => {
    const dir = project({ "routes/hooks/github.tsx": "export default () => null\n" })
    const mounts = [{ path: "/hooks/*", app: { fetch: () => new Response() } }]
    expect(() => assertNoShadowedPages(loaded(dir, { mounts }, undefined))).toThrow(
      "hooks/github.tsx serves /hooks/github, under the mount at /hooks",
    )
  })
})

describe("readStaticApiPrefix", () => {
  test("a string literal export is read", () => {
    expect(readStaticApiPrefix('export const apiPrefix = "/rpc"\n')).toEqual({
      kind: "literal",
      value: "/rpc",
    })
    expect(readStaticApiPrefix("export const apiPrefix: string = '/x';")).toEqual({
      kind: "literal",
      value: "/x",
    })
    expect(readStaticApiPrefix('export const apiPrefix = ""')).toEqual({
      kind: "literal",
      value: "",
    })
    expect(readStaticApiPrefix('export const apiPrefix = "/x" as const\n')).toEqual({
      kind: "literal",
      value: "/x",
    })
  })

  test("no mention means the default; a mention it cannot read is unreadable", () => {
    expect(readStaticApiPrefix("export const adapter = {}")).toEqual({ kind: "default" })
    expect(readStaticApiPrefix("// export const apiPrefix = 1\nexport const a = 1")).toEqual({
      kind: "default",
    })
    expect(readStaticApiPrefix("export const apiPrefix = base + '/x'")).toEqual({
      kind: "unreadable",
    })
    expect(readStaticApiPrefix('export { apiPrefix } from "./config.ts"')).toEqual({
      kind: "unreadable",
    })
  })
})

describe("NF-C027", () => {
  const scan = (dir: string) => {
    const facts = projectFacts("backend/app.ts", "", [])
    return runRuleRegistry({ root: dir, sources: facts.source, project: facts }, pageRules)
  }
  const backendSource = 'import { server } from "@nifrajs/core"\nexport const backend = server()\n'

  test("a page under the default backend prefix is an error naming the file", async () => {
    const dir = project({
      "backend/app.ts": backendSource,
      "backend/framework.ts": adapterSource.join("\n"),
      "routes/index.tsx": "export default () => null\n",
      "routes/api/report.tsx": "export default () => null\n",
    })
    const findings = await scan(dir)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      code: "NF-C027",
      severity: "error",
      file: "routes/api/report.tsx",
    })
    expect(findings[0]?.message).toContain("can never render")
  })

  test("a literal apiPrefix moves the check; an empty one turns it off", async () => {
    const files = {
      "backend/app.ts": backendSource,
      "routes/api/report.tsx": "export default () => null\n",
      "routes/rpc/x.tsx": "export default () => null\n",
    }
    const moved = await scan(
      project({
        ...files,
        "backend/framework.ts": [...adapterSource, 'export const apiPrefix = "/rpc"'].join("\n"),
      }),
    )
    expect(moved.map((finding) => finding.file)).toEqual(["routes/rpc/x.tsx"])
    const off = await scan(
      project({
        ...files,
        "backend/framework.ts": [...adapterSource, 'export const apiPrefix = ""'].join("\n"),
      }),
    )
    expect(off).toEqual([])
  })

  test("an apiPrefix it cannot read is reported as info, never guessed", async () => {
    const findings = await scan(
      project({
        "backend/app.ts": backendSource,
        "backend/framework.ts": [...adapterSource, 'export const apiPrefix = "/" + "rpc"'].join(
          "\n",
        ),
        "routes/api/report.tsx": "export default () => null\n",
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      code: "NF-C027",
      severity: "info",
      file: "backend/framework.ts",
    })
  })

  test("no backend export means no mount, so nothing is reported", async () => {
    expect(await scan(project({ "routes/api/report.tsx": "export default () => null\n" }))).toEqual(
      [],
    )
    expect(
      await scan(
        project({
          "backend/app.ts": "export const notTheBackend = 1\n",
          "routes/api/report.tsx": "export default () => null\n",
        }),
      ),
    ).toEqual([])
  })
})

describe("nifra routes reads the configured prefix", () => {
  test("apiStrip lists every backend route at the path a request uses", () => {
    const rows = buildRouteTable({
      pages: [],
      api: [
        { method: "get", path: "/sync" },
        { method: "get", path: "/" },
      ],
      apiPrefix: "/api/",
      apiStrip: true,
    })
    expect(rows).toEqual([
      { kind: "api", path: "/api", methods: ["GET"], autoMounted: true },
      { kind: "api", path: "/api/sync", methods: ["GET"], autoMounted: true },
    ])
  })

  test("a root prefix mounts every backend route", () => {
    const rows = buildRouteTable({
      pages: [],
      api: [{ method: "get", path: "/x" }],
      apiPrefix: "/",
    })
    expect(rows).toEqual([{ kind: "api", path: "/x", methods: ["GET"], autoMounted: true }])
  })
})
