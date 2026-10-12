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

  test("an apiPrefix nifra.config.ts does not re-export is reported there: nifra dev loads it alone", async () => {
    const config = 'export { adapter } from "./backend/framework"\n'
    const dir = project({
      "backend/app.ts": backendSource,
      "backend/framework.ts": [...adapterSource, 'export const apiPrefix = "/api"'].join("\n"),
      "nifra.config.ts": config,
    })
    const findings = await scan(dir)
    expect(findings.map((finding) => [finding.severity, finding.file, finding.evidence])).toEqual([
      [
        "warn",
        "nifra.config.ts",
        ["production: backend/framework.ts", "nifra dev: nifra.config.ts"],
      ],
    ])
    expect(findings[0]?.message).toContain("serves backend/app.ts's backend at /api")
    expect(findings[0]?.message).toContain('export { apiPrefix } from "./backend/framework"')
    expect(await fix(dir, findings[0])).toEqual(["nifra.config.ts"])
    expect(readFileSync(join(dir, "nifra.config.ts"), "utf8")).toBe(
      `${config}export { apiPrefix } from "./backend/framework"\n`,
    )
    expect(await scan(dir)).toEqual([])
  })

  test("both configs without apiPrefix: the fix mounts it in backend/framework.ts and re-exports it", async () => {
    const dir = project({
      "backend/app.ts": backendSource,
      "backend/framework.ts": adapterSource.join("\n"),
      "nifra.config.ts": 'export { adapter } from "./backend/framework.ts"',
    })
    const findings = await scan(dir)
    expect(findings.map((finding) => [finding.severity, finding.file])).toEqual([
      ["warn", "backend/framework.ts"],
    ])
    expect(findings[0]?.message).toContain(
      're-export it from nifra.config.ts, which nifra dev loads: `export { apiPrefix } from "./backend/framework.ts"`',
    )
    expect(await fix(dir, findings[0])).toEqual(["backend/framework.ts", "nifra.config.ts"])
    expect(readFileSync(join(dir, "nifra.config.ts"), "utf8")).toBe(
      'export { adapter } from "./backend/framework.ts"\nexport { apiPrefix } from "./backend/framework.ts"\n',
    )
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
