import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  assertFrameworkOptionsEdgeExported,
  assertNoShadowedPages,
  showsIndicator,
} from "../src/cli.ts"
import type { Diagnostic } from "../src/diagnostics.ts"
import { getFixRecipe } from "../src/fix-recipes.ts"
import type { TypeScriptSession } from "../src/internal/typescript-import.ts"
import { buildRouteTable, unservedRoutesWarning } from "../src/introspect.ts"
import { type LoadedApp, loadApp, type NifraFramework } from "../src/load.ts"
import { type RuleContext, runRuleRegistry, sourceIndex } from "../src/rules/index.ts"
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
    ["export const live = { publish() {} }", "`live` must be the runtime live() from"],
    // A misspelled trust declaration must not quietly build an edge app with no caller address.
    ["export const clientIp = 'cf-connecting-ip'", '`clientIp` must be "platform"'],
    ["export const dev = 'quiet'", "`dev` must be an object"],
    ["export const dev = { indicator: 'off' }", "`dev.indicator` must be a boolean"],
    [
      "export const dev = { allowedHosts: 'app.test' }",
      "`dev.allowedHosts` must be an array of host names",
    ],
    [
      "export const dev = { allowedHosts: [''] }",
      "`dev.allowedHosts` must be an array of host names",
    ],
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

  test("with both configs, a server option nifra.config.ts leaves unset comes from backend/framework.ts", async () => {
    const dir = project({
      "backend/framework.ts": [
        ...adapterSource,
        'export const apiPrefix = "/api"',
        "export const apiStrip = true",
        "export const use = () => {}",
      ].join("\n"),
      "nifra.config.ts": [
        'export { adapter, clientModule } from "./backend/framework.ts"',
        "export const apiStrip = false",
      ].join("\n"),
      "routes/index.tsx": "export default () => null\n",
    })
    const app = await loadApp(dir)
    expect(app.configPath).toBe(join(dir, "nifra.config.ts"))
    expect(app.framework.apiPrefix).toBe("/api")
    expect(app.framework.apiStrip).toBe(false)
    expect(typeof app.framework.use).toBe("function")
    expect(frameworkOptionImports(app.framework, join(dir, "backend/framework.ts"))).toEqual({
      optionImports: {
        apiPrefix: join(dir, "backend/framework.ts"),
        apiStrip: join(dir, "backend/framework.ts"),
      },
    })
  })

  test("publicEnvPrefix set only in backend/framework.ts reaches every command beside nifra.config.ts", async () => {
    const dir = project({
      "backend/framework.ts": [...adapterSource, 'export const publicEnvPrefix = "SITE_"'].join(
        "\n",
      ),
      "nifra.config.ts": 'export { adapter, clientModule } from "./backend/framework.ts"\n',
      "routes/index.tsx": "export default () => null\n",
    })
    expect((await loadApp(dir)).framework.publicEnvPrefix).toBe("SITE_")
    // It is not a server-entry option: the generated entry imports nothing new.
    expect(
      frameworkOptionImports((await loadApp(dir)).framework, join(dir, "backend/framework.ts")),
    ).toEqual({})
    writeFileSync(
      join(dir, "nifra.config.ts"),
      'export { adapter, clientModule } from "./backend/framework.ts"\nexport const publicEnvPrefix = "EDGE_"\n',
    )
    expect((await loadApp(dir, "dist", { importQuery: "v=2" })).framework.publicEnvPrefix).toBe(
      "EDGE_",
    )
  })

  test("a publicEnvPrefix that is not a string is refused", async () => {
    const dir = project({
      "backend/framework.ts": [...adapterSource, "export const publicEnvPrefix = 7"].join("\n"),
      "nifra.config.ts": 'export { adapter, clientModule } from "./backend/framework.ts"\n',
      "routes/index.tsx": "export default () => null\n",
    })
    await expect(loadApp(dir)).rejects.toThrow(
      "backend/framework.ts: `publicEnvPrefix` must be a string",
    )
  })

  test("an option taken from backend/framework.ts is validated there", async () => {
    const dir = project({
      "backend/framework.ts": [...adapterSource, "export const apiPrefix = 42"].join("\n"),
      "nifra.config.ts": 'export { adapter, clientModule } from "./backend/framework.ts"\n',
      "routes/index.tsx": "export default () => null\n",
    })
    await expect(loadApp(dir)).rejects.toThrow("backend/framework.ts: `apiPrefix` must be")
  })

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

  test("a live runtime loads, and its client entry is what dev and the build hand the client", async () => {
    const dir = project({
      "backend/framework.ts": [
        ...adapterSource,
        'import { live as createLive } from "@nifrajs/web/live"',
        'export const live = createLive({ secret: "cli-live-secret-0123456789abcdef-01", subject: () => null, path: "/rt" })',
      ].join("\n"),
      "routes/index.tsx": "export default () => null\n",
    })
    const app = await loadApp(dir)
    expect(app.framework.live?.clientEntry).toEqual({ path: "/rt" })
    expect(frameworkWebAppOptions(app.framework, undefined).live).toBe(app.framework.live)
  })
})

test("dev.indicator and --no-indicator each turn the badge off", async () => {
  const dir = project({
    "backend/framework.ts": [...adapterSource, "export const dev = { indicator: false }"].join(
      "\n",
    ),
    "routes/index.tsx": "export default () => null\n",
  })
  const app = await loadApp(dir)
  expect(showsIndicator({ noIndicator: false }, app.framework)).toBe(false)
  expect(showsIndicator({ noIndicator: false }, fw({}))).toBe(true)
  expect(showsIndicator({ noIndicator: false }, fw({ dev: { indicator: true } }))).toBe(true)
  expect(showsIndicator({ noIndicator: true }, fw({ dev: { indicator: true } }))).toBe(false)
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
    expect(frameworkMountPaths(fw({ mounts, apiPrefix: "/api" }), true)).toEqual(["/hooks", "/api"])
    expect(frameworkMountPaths(fw({ mounts, apiPrefix: "/api" }), false)).toEqual(["/hooks"])
    expect(frameworkMountPaths(fw({ mounts }), true)).toEqual(["/hooks"])
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

  test("a page under the backend's apiPrefix blocks the build", () => {
    const dir = project({ "routes/api/report.tsx": "export default () => null\n" })
    expect(() => assertNoShadowedPages(loaded(dir, { apiPrefix: "/api" }, {}))).toThrow(
      "build blocked: 1 page route can never render",
    )
  })

  test("no backend, no or an empty prefix, or a page outside the prefix builds", () => {
    const dir = project({ "routes/api/report.tsx": "export default () => null\n" })
    expect(() => assertNoShadowedPages(loaded(dir, { apiPrefix: "/api" }, undefined))).not.toThrow()
    expect(() => assertNoShadowedPages(loaded(dir, {}, {}))).not.toThrow()
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
  const scan = async (dir: string) => {
    const facts = projectFacts("backend/app.ts", "", [])
    const findings = await runRuleRegistry(
      { root: dir, sources: facts.source, project: facts },
      pageRules,
    )
    return findings.filter((finding) => finding.code === "NF-C027")
  }
  const backendSource = 'import { server } from "@nifrajs/core"\nexport const backend = server()\n'

  test("a page under the backend's apiPrefix is an error naming the file", async () => {
    const files = {
      "backend/app.ts": backendSource,
      "routes/index.tsx": "export default () => null\n",
      "routes/api/report.tsx": "export default () => null\n",
    }
    // Without an apiPrefix the backend is not mounted, so nothing is shadowed.
    expect(
      await scan(project({ ...files, "backend/framework.ts": adapterSource.join("\n") })),
    ).toEqual([])
    const dir = project({
      ...files,
      "backend/framework.ts": [...adapterSource, 'export const apiPrefix = "/api"'].join("\n"),
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

  test("a route outside the prefix with apiStrip off is in-process only, and dev and build say so", async () => {
    const api = [
      { method: "get", path: "/hello" },
      { method: "post", path: "/api/items" },
    ]
    expect(buildRouteTable({ pages: [], api, apiPrefix: "/api" })).toEqual([
      { kind: "api", path: "/api/items", methods: ["POST"], autoMounted: true },
      { kind: "api", path: "/hello", methods: ["GET"], autoMounted: false, inProcessOnly: true },
    ])
    expect(buildRouteTable({ pages: [], api })[1]).toEqual({
      kind: "api",
      path: "/hello",
      methods: ["GET"],
      autoMounted: false,
    })
    const { server } = await import("@nifrajs/core")
    const backend = server()
      .get("/hello", () => "hi")
      .group("/api", (api) => api.get("/items", () => []))
    expect(unservedRoutesWarning({ framework: fw({ apiPrefix: "/api" }), backend })).toContain(
      "a backend route is served over HTTP nowhere: GET /hello.",
    )
    expect(
      unservedRoutesWarning({ framework: fw({ apiPrefix: "/api", apiStrip: true }), backend }),
    ).toBeUndefined()
    expect(unservedRoutesWarning({ framework: fw({ apiPrefix: "" }), backend })).toBeUndefined()
  })
})

describe("NF-C034", () => {
  const scan = (dir: string) => {
    const facts = projectFacts("routes/index.tsx", "", [])
    return runRuleRegistry({ root: dir, sources: facts.source, project: facts }, pageRules)
  }

  test("a root status page that wraps the root layout itself is reported", async () => {
    const wraps = 'import Layout from "./_layout"\nexport default () => Layout\n'
    const findings = await scan(
      project({
        "routes/_layout.tsx": "export default () => null\n",
        "routes/_404.tsx": wraps,
        "routes/_503.tsx": 'import Layout from "./_layout.tsx"\nexport default () => Layout\n',
        "routes/_451.tsx": `export const inLayouts = false\n${wraps}`,
        "routes/_410.tsx": "export default () => null\n",
        "routes/_429.tsx": '// import Layout from "./_layout"\nexport default () => null\n',
        "routes/_error.tsx": wraps,
        "routes/admin/_404.tsx": 'import Layout from "../_layout"\nexport default () => Layout\n',
        "routes/index.tsx": "export default () => null\n",
      }),
    )
    expect(findings.map((finding) => [finding.code, finding.severity, finding.file])).toEqual([
      ["NF-C034", "warn", "routes/_404.tsx"],
      ["NF-C034", "warn", "routes/_503.tsx"],
    ])
    expect(findings[0]?.message).toContain("renders routes/_layout.tsx twice")
    expect(findings[0]?.message).toContain("export const inLayouts = false")
  })

  test("without a root layout there is nothing to render inside", async () => {
    expect(
      await scan(
        project({
          "routes/admin/_layout.tsx": "export default () => null\n",
          "routes/_404.tsx": "export default () => null\n",
          "routes/index.tsx": "export default () => null\n",
        }),
      ),
    ).toEqual([])
  })
})

describe("NF-C035", () => {
  const scan = async (dir: string) => {
    const facts = projectFacts("backend/app.ts", "", [])
    const findings = await runRuleRegistry(
      { root: dir, sources: facts.source, project: facts },
      pageRules,
    )
    return findings.filter((finding) => finding.code === "NF-C035")
  }
  const backendSource = 'import { server } from "@nifrajs/core"\nexport const backend = server()\n'

  test("a backend with no apiPrefix is reported as not served over HTTP, with a fix", async () => {
    const dir = project({
      "backend/app.ts": backendSource,
      "backend/framework.ts": adapterSource.join("\n"),
      "routes/index.tsx": "export default () => null\n",
    })
    const findings = await scan(dir)
    expect(findings.map((finding) => [finding.severity, finding.file, finding.fix])).toEqual([
      [
        "warn",
        "backend/framework.ts",
        { recipe: "framework.api-prefix", command: "nifra fix --code NF-C035" },
      ],
    ])
    expect(findings[0]?.message).toContain("not served over HTTP")
    expect(findings[0]?.message).toContain('export const apiPrefix = "/api"')
    expect(findings[0]?.message).toContain('export const apiPrefix = ""')
    const recipe = getFixRecipe("framework.api-prefix")
    const finding = findings[0]
    if (recipe === undefined || finding === undefined) throw new Error("no fix recipe")
    expect(await recipe.apply(dir, finding)).toEqual(["backend/framework.ts"])
    expect(readStaticApiPrefix(readFileSync(join(dir, "backend/framework.ts"), "utf8"))).toEqual({
      kind: "literal",
      value: "/api",
    })
    expect(await scan(dir)).toEqual([])
    expect(await recipe.apply(dir, finding)).toEqual([])
  })

  test("an explicit apiPrefix, or no backend, is not reported", async () => {
    for (const prefix of ['"/api"', '""', '"/rpc"']) {
      expect(
        await scan(
          project({
            "backend/app.ts": backendSource,
            "backend/framework.ts": [...adapterSource, `export const apiPrefix = ${prefix}`].join(
              "\n",
            ),
          }),
        ),
      ).toEqual([])
    }
    expect(await scan(project({ "backend/framework.ts": adapterSource.join("\n") }))).toEqual([])
  })

  const fix = async (dir: string, finding: Diagnostic | undefined): Promise<readonly string[]> => {
    const recipe = getFixRecipe("framework.api-prefix")
    if (recipe === undefined || finding === undefined) throw new Error("no fix recipe")
    return recipe.apply(dir, finding)
  }

  test("an apiPrefix only backend/framework.ts sets is the app's, so it is not reported", async () => {
    expect(
      await scan(
        project({
          "backend/app.ts": backendSource,
          "backend/framework.ts": [...adapterSource, 'export const apiPrefix = "/api"'].join("\n"),
          "nifra.config.ts": 'export { adapter } from "./backend/framework"\n',
        }),
      ),
    ).toEqual([])
  })

  test("both configs without apiPrefix: the fix mounts it in backend/framework.ts alone", async () => {
    const config = 'export { adapter } from "./backend/framework.ts"'
    const dir = project({
      "backend/app.ts": backendSource,
      "backend/framework.ts": adapterSource.join("\n"),
      "nifra.config.ts": config,
    })
    const findings = await scan(dir)
    expect(findings.map((finding) => [finding.severity, finding.file])).toEqual([
      ["warn", "backend/framework.ts"],
    ])
    expect(await fix(dir, findings[0])).toEqual(["backend/framework.ts"])
    expect(readFileSync(join(dir, "nifra.config.ts"), "utf8")).toBe(config)
    expect(await scan(dir)).toEqual([])
    expect(await fix(dir, findings[0])).toEqual([])
  })

  test("nifra.config.ts exporting the same apiPrefix, or both sides loader-only, is not reported", async () => {
    const framework = [...adapterSource, 'export const apiPrefix = "/api"'].join("\n")
    for (const config of [
      'export { adapter, apiPrefix } from "./backend/framework"\n',
      'export * from "./backend/framework.ts"\n',
      'export { adapter } from "./backend/framework"\nexport const apiPrefix = "/api"\n',
    ]) {
      expect(
        await scan(
          project({
            "backend/app.ts": backendSource,
            "backend/framework.ts": framework,
            "nifra.config.ts": config,
          }),
        ),
      ).toEqual([])
    }
    expect(
      await scan(
        project({
          "backend/app.ts": backendSource,
          "backend/framework.ts": [...adapterSource, 'export const apiPrefix = ""'].join("\n"),
          "nifra.config.ts": 'export { adapter } from "./backend/framework"\n',
        }),
      ),
    ).toEqual([])
  })

  test("an apiPrefix only nifra.config.ts sets is left to the load error that names it", async () => {
    expect(
      await scan(
        project({
          "backend/app.ts": backendSource,
          "backend/framework.ts": adapterSource.join("\n"),
          "nifra.config.ts":
            'export { adapter } from "./backend/framework"\nexport const apiPrefix = "/api"\n',
        }),
      ),
    ).toEqual([])
  })

  describe("an app module that calls createWebApp itself", () => {
    const framework = (prefix: string): string =>
      [...adapterSource, `export const apiPrefix = ${prefix}`].join("\n")
    // Every fixture file is in the source index, as the check's own walk would list them.
    const scanEntry = async (files: Record<string, string>) => {
      const dir = project({ "backend/app.ts": backendSource, ...files })
      const facts = projectFacts("backend/app.ts", backendSource, [])
      const sources = sourceIndex(
        Object.entries(files).map(([file, content]) => ({ file, content })),
      )
      const findings = await runRuleRegistry(
        { root: dir, sources, project: { ...facts, source: sources } },
        pageRules,
      )
      return findings.filter((finding) => finding.code === "NF-C035")
    }
    const entry = (...lines: string[]): string =>
      [
        'import { createWebApp } from "@nifrajs/web"',
        'import { inProcessClient } from "@nifrajs/client"',
        'import { backend } from "./backend/app"',
        ...lines,
      ].join("\n")

    test("a mount with no apiPrefix is reported at the call, naming both values", async () => {
      const findings = await scanEntry({
        "backend/framework.ts": framework('"/api"'),
        "server.ts": entry(
          "",
          "export const app = createWebApp({",
          "  api: inProcessClient(backend),",
          "})",
        ),
      })
      expect(findings.map((f) => [f.severity, f.file, f.line, f.fix])).toEqual([
        ["warn", "server.ts", 5, undefined],
      ])
      expect(findings[0]?.message).toContain("serves the backend nowhere")
      expect(findings[0]?.message).toContain("`nifra dev` serves it at /api (backend/framework.ts)")
      expect(findings[0]?.message).toContain('import { apiPrefix } from "./backend/framework"')
      expect(findings[0]?.evidence).toEqual([
        "createWebApp apiPrefix: unset",
        'backend/framework.ts apiPrefix: "/api"',
      ])
    })

    test("a nifra-expect comment on the call or its apiPrefix line accepts the difference", async () => {
      const accepted = [
        [
          "// nifra-expect NF-C035: the outer server mounts the backend at /api",
          "export const app = createWebApp({ api: inProcessClient(backend) })",
        ],
        [
          "export const app = createWebApp({",
          "  api: inProcessClient(backend),",
          "  // The outer server mounts the backend at /api, behind its own middleware.",
          "  // nifra-expect NF-C035: a second mount here would skip that middleware",
          '  apiPrefix: "",',
          "})",
        ],
        ["export const app = createWebApp({ api: backend }) // nifra-expect NF-C035"],
      ]
      for (const lines of accepted) {
        expect(
          await scanEntry({
            "backend/framework.ts": framework('"/api"'),
            "server.ts": entry(...lines),
          }),
        ).toEqual([])
      }
      const otherCode = await scanEntry({
        "backend/framework.ts": framework('"/api"'),
        "server.ts": entry(
          "// nifra-expect NF-C027: unrelated",
          "export const app = createWebApp({ api: backend })",
        ),
      })
      expect(otherCode.map((f) => f.line)).toEqual([5])
    })

    test("the advice names the hatch, and warns that a second mount skips the other server's middleware", async () => {
      const [none] = await scanEntry({
        "backend/framework.ts": framework('"/api"'),
        "server.ts": entry('export const app = createWebApp({ api: backend, apiPrefix: "" })'),
      })
      expect(none?.message).toContain(
        "If another server already serves this backend at /api, mark the call with `// nifra-expect NF-C035: <reason>` instead: an apiPrefix here would add a second path to it that skips that server's middleware.",
      )
      const [other] = await scanEntry({
        "backend/framework.ts": framework('"/api"'),
        "server.ts": entry('export const app = createWebApp({ api: backend, apiPrefix: "/v1" })'),
      })
      expect(other?.message).toEndWith(
        "If another server already serves this backend at /api, mark the call with `// nifra-expect NF-C035: <reason>` instead.",
      )
      const [, devNowhere] = await scanEntry({
        "backend/framework.ts": adapterSource.join("\n"),
        "server.ts": entry('export const app = createWebApp({ api: backend, apiPrefix: "/api" })'),
      })
      expect(devNowhere?.message).toEndWith(
        "Mark a deliberate difference with `// nifra-expect NF-C035: <reason>` above the call.",
      )
    })

    test("a different literal or same-module const is reported; the import path is relative to the entry", async () => {
      const findings = await scanEntry({
        "backend/framework.ts": framework('"/api"'),
        "src/server/entry.ts": [
          'import * as web from "@nifrajs/web"',
          'const PREFIX = "/v1"',
          "export const a = web.createWebApp({ api: client, apiPrefix: PREFIX })",
          'export const b = web.createWebApp({ api: client, apiPrefix: "/rpc" as const })',
        ].join("\n"),
      })
      expect(findings.map((f) => [f.file, f.line])).toEqual([
        ["src/server/entry.ts", 3],
        ["src/server/entry.ts", 4],
      ])
      expect(findings[0]?.message).toContain('apiPrefix "/v1"')
      expect(findings[0]?.message).toContain('from "../../backend/framework"')
    })

    test("a mount where nifra dev serves nothing is reported, beside the framework finding", async () => {
      const findings = await scanEntry({
        "backend/framework.ts": adapterSource.join("\n"),
        "server.ts": entry('export const app = createWebApp({ api: backend, apiPrefix: "/api" })'),
      })
      expect(findings.map((f) => [f.file, f.fix?.recipe])).toEqual([
        ["backend/framework.ts", "framework.api-prefix"],
        ["server.ts", undefined],
      ])
      expect(findings[1]?.message).toContain(
        "serves the backend at /api, while `nifra dev` serves it nowhere",
      )
    })

    test("the framework config's own value, a matching literal, or an unreadable one is not reported", async () => {
      const unreported = [
        'import { apiPrefix } from "./backend/framework"\nexport const app = createWebApp({ api: backend, apiPrefix })',
        'import { apiPrefix as prefix } from "./backend/framework.ts"\nexport const app = createWebApp({ api: backend, apiPrefix: prefix })',
        'import * as fw from "./backend/framework"\nexport const app = createWebApp({ api: backend, apiPrefix: fw.apiPrefix })',
        'export const app = createWebApp({ api: backend, apiPrefix: "/api" })',
        "export const app = createWebApp({ apiPrefix: '/x', ...options, api: backend })",
        "export const app = createWebApp({ api: backend, apiPrefix: process.env.PREFIX })",
        "export const app = createWebApp(options)",
        "export const app = createWebApp({ adapter })",
      ]
      for (const line of unreported) {
        expect(
          await scanEntry({
            "backend/framework.ts": framework('"/api"'),
            "server.ts": entry(line),
          }),
        ).toEqual([])
      }
    })

    test("a createWebApp that is not @nifrajs/web's, or an unreadable framework value, is not read", async () => {
      expect(
        await scanEntry({
          "backend/framework.ts": framework('"/api"'),
          "server.ts":
            'import { createWebApp } from "./local"\nexport const app = createWebApp({ api: 1 })',
        }),
      ).toEqual([])
      expect(
        await scanEntry({
          "backend/framework.ts": [...adapterSource, "export const apiPrefix = PREFIX"].join("\n"),
          "server.ts": entry("export const app = createWebApp({ api: backend })"),
        }),
      ).toEqual([])
    })

    test("nifra.config.ts's own apiPrefix is the value compared, and named as its origin", async () => {
      const findings = await scanEntry({
        "backend/framework.ts": framework('"/api"'),
        "nifra.config.ts":
          'export { adapter } from "./backend/framework"\nexport const apiPrefix = "/v2"\n',
        "server.ts": entry('export const app = createWebApp({ api: backend, apiPrefix: "/api" })'),
      })
      expect(findings.map((f) => f.evidence)).toEqual([
        ['createWebApp apiPrefix: "/api"', 'nifra.config.ts apiPrefix: "/v2"'],
      ])
    })
  })

  test("an API-only app, with no web config or a nifra.config.ts with no adapter, is not reported", async () => {
    expect(await scan(project({ "backend/app.ts": backendSource }))).toEqual([])
    expect(
      await scan(
        project({
          "backend/app.ts": backendSource,
          "nifra.config.ts": "export const target = 'bun'\n",
        }),
      ),
    ).toEqual([])
  })
})

describe("NF-C040", () => {
  const scan = async (dir: string) => {
    const facts = projectFacts("routes/index.tsx", "", [])
    const findings = await runRuleRegistry(
      { root: dir, sources: facts.source, project: facts },
      pageRules,
    )
    return findings.filter((finding) => finding.code === "NF-C040")
  }

  test("a layout with no loader whose meta reads data is reported at the read", async () => {
    const findings = await scan(
      project({
        "routes/_layout.tsx": [
          'import type { MetaArgs } from "@nifrajs/web"',
          "export const meta = ({ data }: MetaArgs) => ({",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated route module's own template literal
          "  title: `${(data as { title: string }).title} | Site`,",
          "})",
          "export default () => null",
          "",
        ].join("\n"),
        "routes/docs/_layout.tsx":
          "export function meta(args) {\n  return { title: args.data.title }\n}\nexport default () => null\n",
        "routes/blog/_layout.tsx":
          "export const meta = ({ data: page }) => ({ title: page.title })\nexport default () => null\n",
        "routes/index.tsx": "export default () => null\n",
      }),
    )
    expect(findings.map((finding) => [finding.severity, finding.file, finding.line])).toEqual([
      ["warn", "routes/_layout.tsx", 2],
      ["warn", "routes/blog/_layout.tsx", 1],
      ["warn", "routes/docs/_layout.tsx", 2],
    ])
    expect(findings[0]?.message).toContain("Read the page's data from `pageData`")
  })

  test("a layout that loads, reads pageData, or has static meta is not reported", async () => {
    expect(
      await scan(
        project({
          "routes/_layout.tsx":
            "export const meta = ({ data }) => ({ lang: data.locale })\nexport default () => null\n",
          "routes/_layout.backend.ts": "export const loader = () => ({ locale: 'hi' })\n",
          "routes/a/_layout.tsx":
            "export const meta = ({ pageData }) => ({ title: pageData.title })\nexport default () => null\n",
          "routes/b/_layout.tsx": 'export const meta = { title: "B" }\nexport default () => null\n',
          "routes/c/_layout.tsx":
            "// export const meta = ({ data }) => data\nexport default () => null\n",
          "routes/d/_layout.tsx":
            "export const loader = () => ({})\nexport const meta = ({ data }) => data\nexport default () => null\n",
          "routes/index.tsx": "export default () => null\n",
        }),
      ),
    ).toEqual([])
  })
})

describe("NF-C041", () => {
  const scan = async (dir: string) => {
    const facts = projectFacts("routes/index.tsx", "", [])
    const findings = await runRuleRegistry(
      { root: dir, sources: facts.source, project: facts },
      pageRules,
    )
    return findings.filter((finding) => finding.code === "NF-C041")
  }

  test("a server-only export in a page, layout or status page is an error at its line", async () => {
    const dir = project({
      "routes/index.tsx": [
        "export default () => null",
        "export async function loader() { return { n: 1 } }",
      ].join("\n"),
      "routes/_layout.tsx": [
        "const action = async () => null",
        "export default ({ children }: { children: unknown }) => children",
        "export { action }",
      ].join("\n"),
      "routes/_404.tsx": "export const revalidate = 60\nexport default () => null\n",
      "routes/docs/[slug].tsx":
        "export default () => null\nexport const getStaticPaths = () => []\n",
    })
    const findings = await scan(dir)
    expect(findings.map((finding) => [finding.severity, finding.file, finding.line])).toEqual([
      ["error", "routes/_404.tsx", 1],
      ["error", "routes/_layout.tsx", 3],
      ["error", "routes/docs/[slug].tsx", 2],
      ["error", "routes/index.tsx", 2],
    ])
    expect(findings.at(-1)?.message).toContain('exports "loader", which runs on the server only')
    expect(findings.at(-1)?.message).toContain("Move it to routes/index.backend.ts")
  })

  test("the fix moves the export and the code only it uses into the backend half", async () => {
    const dir = project({
      "routes/index.tsx": [
        'import { useLoaderData } from "@nifrajs/web-react"',
        "const query = () => ({ n: 1 })",
        "export async function loader() { return query() }",
        "export default () => useLoaderData()",
      ].join("\n"),
      "routes/index.backend.ts": "export const revalidate = 60\n",
    })
    const findings = await scan(dir)
    expect(findings[0]?.fix).toEqual({ recipe: "route.split", command: "nifra fix --code NF-C041" })
    const recipe = getFixRecipe("route.split")
    if (recipe === undefined || findings[0] === undefined) throw new Error("no fix recipe")
    expect(await recipe.apply(dir, findings[0])).toEqual([
      "routes/index.tsx",
      "routes/index.backend.ts",
    ])
    const frontend = readFileSync(join(dir, "routes/index.tsx"), "utf8")
    const backend = readFileSync(join(dir, "routes/index.backend.ts"), "utf8")
    expect(frontend).not.toContain("query")
    expect(backend).toContain("export const revalidate = 60")
    expect(backend).toContain("const query = () => ({ n: 1 })")
    expect(backend).toContain("export async function loader()")
    expect(await scan(dir)).toEqual([])
  })

  test("frontend exports, type-only exports and the backend half are not reported", async () => {
    const dir = project({
      "routes/index.tsx": [
        'import type { loader } from "./index.backend.ts"',
        "export type Data = Awaited<ReturnType<typeof loader>>",
        "export type { loader as Loader }",
        "export const meta = () => ({ title: 'x' })",
        "export const clientLoader = async () => null",
        "export default () => null",
      ].join("\n"),
      "routes/index.backend.ts": "export async function loader() { return null }\n",
    })
    expect(await scan(dir)).toEqual([])
  })
})

describe("NF-C042", () => {
  const scan = async (dir: string) => {
    const facts = projectFacts("routes/index.tsx", "", [])
    const findings = await runRuleRegistry(
      { root: dir, sources: facts.source, project: facts },
      pageRules,
    )
    return findings.filter((finding) => finding.code === "NF-C042")
  }
  const layout = "export default () => null\n"

  test("a layout loader that refuses access without a gate or middleware is reported", async () => {
    const findings = await scan(
      project({
        "routes/admin/_layout.tsx": layout,
        "routes/admin/_layout.backend.ts": [
          'import { redirect } from "@nifrajs/web"',
          "export const loader = ({ request }) => {",
          '  if (!request.headers.get("cookie")) throw redirect("/login")',
          "  return { ok: true }",
          "}",
          "",
        ].join("\n"),
        "routes/billing/_layout.tsx": layout,
        "routes/billing/_layout.backend.ts":
          "export async function loader() {\n  throw new Response(null, { status: 401 })\n}\n",
        "routes/staff/_layout.tsx": layout,
        "routes/staff/_layout.backend.ts":
          'import { statusPage } from "@nifrajs/web"\nexport const loader = () => statusPage(403)\n',
        "routes/index.tsx": layout,
      }),
    )
    expect(findings.map((finding) => [finding.severity, finding.file, finding.line])).toEqual([
      ["warn", "routes/admin/_layout.backend.ts", 3],
      ["warn", "routes/billing/_layout.backend.ts", 2],
      ["warn", "routes/staff/_layout.backend.ts", 2],
    ])
    expect(findings[0]?.message).toContain("Export `gate = true`")
  })

  test("a gate, a middleware, a missing record, or no refusal is not reported", async () => {
    const refusing = 'export const loader = () => {\n  throw redirect("/login")\n}\n'
    expect(
      await scan(
        project({
          "routes/a/_layout.tsx": layout,
          "routes/a/_layout.backend.ts": `export const gate = true\n${refusing}`,
          "routes/b/_layout.tsx": layout,
          "routes/b/_layout.backend.ts": `export const middleware = () => undefined\n${refusing}`,
          "routes/c/_layout.tsx": layout,
          "routes/c/_layout.backend.ts":
            "export const loader = ({ params }) => {\n  if (!params.slug) notFound()\n  return statusPage(404)\n}\n",
          "routes/d/_layout.tsx": layout,
          "routes/d/_layout.backend.ts":
            '// throw redirect("/login")\nexport const loader = () => ({ menu: [] })\n',
          "routes/e/_layout.tsx": layout,
          "routes/e/_layout.backend.ts": `const guard = () => {\n  throw redirect("/login")\n}\nexport const loader = () => guard()\n`,
          "routes/index.tsx": layout,
        }),
      ),
    ).toEqual([])
  })
})

describe("NF-C044", () => {
  const definer = [
    'import { defineCopy } from "@nifrajs/i18n/copy"',
    'export const copy = defineCopy({ locales: ["en", "hi"], defaultLocale: "en" })',
  ].join("\n")
  const scan = async (files: Record<string, string>, session?: TypeScriptSession) => {
    const dir = project(files)
    const facts = projectFacts("backend/app.ts", "", [])
    const sources = sourceIndex(Object.entries(files).map(([file, content]) => ({ file, content })))
    const ctx: RuleContext = { root: dir, sources, project: { ...facts, source: sources } }
    const findings = await runRuleRegistry(
      session === undefined ? ctx : { ...ctx, typescriptSession: session },
      pageRules,
    )
    return findings.filter((finding) => finding.code === "NF-C044")
  }
  const entry = (...lines: string[]): string =>
    [
      'import { createWebApp } from "@nifrajs/web"',
      'import { clientEntry, manifest } from "./dist/server-manifest"',
      ...lines,
    ].join("\n")

  test("a createWebApp with a clientEntry and no copyChunks in an app with copy tables is reported", async () => {
    const findings = await scan({
      "shared/copy.ts": definer,
      "server.ts": entry(
        "",
        "export const app = createWebApp({",
        "  adapter,",
        "  manifest,",
        "  clientEntry,",
        "})",
      ),
    })
    expect(findings.map((f) => [f.severity, f.file, f.line, f.fix])).toEqual([
      ["warn", "server.ts", 4, undefined],
    ])
    expect(findings[0]?.message).toContain("while shared/copy.ts defines copy tables")
    expect(findings[0]?.message).toContain("`nifra dev` never splits them")
    expect(findings[0]?.message).toContain(
      'Pass `import { copyChunks } from "./dist/server-manifest"` and `createWebApp({ ..., copyChunks })`.',
    )
    expect(findings[0]?.evidence).toEqual([
      "createWebApp copyChunks: unset",
      "copy tables: shared/copy.ts",
    ])
    const [bare] = await scan({
      "shared/copy.ts": definer,
      "server.ts": [
        'import * as web from "@nifrajs/web"',
        "export const app = web.createWebApp({ adapter, manifest, clientEntry: build.entry })",
      ].join("\n"),
    })
    expect(bare?.message).toContain("`buildClient()`'s result")
  })

  test("copyChunks passed or possibly spread in, no clientEntry, no copy tables, or a nifra-expect is not reported", async () => {
    const unreported = [
      "export const app = createWebApp({ adapter, manifest, clientEntry, copyChunks })",
      "export const app = createWebApp({ manifest, clientEntry, copyChunks: assets.copyChunks })",
      "export const app = createWebApp({ manifest, clientEntry, ...built })",
      "export const app = createWebApp({ manifest, clientEntry, [key]: value })",
      "export const app = createWebApp({ manifest })",
      "export const app = createWebApp(options)",
      "// nifra-expect NF-C044: serves the API pages only\nexport const app = createWebApp({ manifest, clientEntry })",
      "export const app = createWebApp({ clientEntry }) // nifra-expect NF-C044",
    ]
    for (const line of unreported) {
      expect(await scan({ "shared/copy.ts": definer, "server.ts": entry(line) })).toEqual([])
    }
    expect(
      await scan({
        "server.ts": entry("export const app = createWebApp({ manifest, clientEntry })"),
      }),
    ).toEqual([])
    expect(
      await scan({
        "shared/copy.ts": definer,
        "server.ts":
          'import { createWebApp } from "./local"\nexport const app = createWebApp({ clientEntry })',
      }),
    ).toEqual([])
  })

  test("under TypeScript 7 the build ships copy tables whole, so nothing is reported", async () => {
    const ts = await import("typescript")
    const files = {
      "shared/copy.ts": definer,
      "server.ts": entry("export const app = createWebApp({ manifest, clientEntry })"),
    }
    const session = (version: string): TypeScriptSession => ({
      compiler: { ...ts, version },
      close: async () => {},
    })
    expect(await scan(files, session("7.0.2"))).toEqual([])
    expect((await scan(files, session("6.0.3"))).map((f) => f.line)).toEqual([3])
  })
})
