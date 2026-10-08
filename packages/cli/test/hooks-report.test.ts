import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ReflectedHookReport } from "@nifrajs/core/reflection"
import { collectCheckResult } from "../src/check.ts"
import { bindCommandArgv, findCommandSpec } from "../src/command-catalog.ts"
import {
  diffHookReports,
  HOOKS_BEFORE_UPGRADE_FILE,
  parseHookReport,
  renderHookDiff,
  renderHookReport,
} from "../src/hooks-report.ts"
import { runUpgrade } from "../src/upgrade.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const FIXTURES = createFixtureRoot("tmp-hooks-report-")
afterAll(() => removeFixtureRoot(FIXTURES))

const BACKEND = `import { server } from "@nifrajs/core/server"
const admin = server()
  .onRequest(function auditAdmin() {})
  .get("/users", () => [])
export const backend = server()
  .onRequest(function requestLog() {})
  .group("/admin", (group) => group.onResponse(function adminHeaders() {}).get("/stats", () => ({})))
  .merge(admin)
  .get("/health", () => "ok")
`

const project = (name: string): string => {
  const root = createFixtureProject(FIXTURES, name)
  writeAppFile(root, "backend/app.ts", BACKEND)
  return root
}

async function routes(cwd: string, argv: readonly string[]) {
  const spec = findCommandSpec("routes")
  if (spec === undefined) throw new Error("routes command missing")
  const input = bindCommandArgv(spec, [...argv])
  const output = await spec.run(input, { cwd, cliVersion: "0.0.0" })
  return {
    ok: spec.success?.(output, input) ?? true,
    data: spec.json?.(output, input),
    text: spec.render(output, input).join("\n"),
  }
}

const report = (rows: Record<string, readonly string[]>): ReflectedHookReport => ({
  complete: true,
  routes: Object.entries(rows).map(([target, names]) => {
    const [method = "GET", path = "/"] = target.split(" ")
    return {
      method,
      path,
      hooks: names.map((name) => ({ kind: "onRequest" as const, name, site: "app" })),
    }
  }),
  unmatched: [],
})

describe("nifra routes --hooks", () => {
  test("lists each route's hooks with the site that registered them", async () => {
    const { ok, data, text } = await routes(project("list-"), ["--hooks"])
    expect(ok).toBe(true)
    const parsed = parseHookReport(JSON.stringify(data))
    expect(parsed?.complete).toBe(true)
    const stats = parsed?.routes.find((row) => row.path === "/admin/stats")
    expect(stats?.hooks.map((hook) => `${hook.kind} ${hook.name} (${hook.site})`)).toEqual([
      "onRequest requestLog (app)",
      "onResponse adminHeaders (group /admin)",
    ])
    const users = parsed?.routes.find((row) => row.path === "/users")
    expect(users?.hooks.map((hook) => hook.site)).toEqual(["app", "merge #1"])
    expect(text).toContain("GET /admin/stats\n  onRequest requestLog (app)")
    expect(text).toContain("unmatched /admin")
  })

  test("--since prints only what runs differently from a saved report", async () => {
    const root = project("since-")
    const { data } = await routes(root, ["--hooks", "--json"])
    const saved = parseHookReport(JSON.stringify(data))
    if (saved === undefined) throw new Error("no report")
    const before: ReflectedHookReport = {
      ...saved,
      routes: saved.routes.map((row) =>
        row.path === "/health"
          ? { ...row, hooks: [...row.hooks, { kind: "around", name: "timing", site: "app" }] }
          : row,
      ),
    }
    await writeFile(join(root, "before.json"), JSON.stringify(before))
    const diff = await routes(root, ["--hooks", "--since", "before.json"])
    expect(diff.ok).toBe(true)
    expect(diff.text).toBe("GET /health\n  - around timing (app)")

    await writeFile(join(root, "broken.json"), '{"routes": "nope"}')
    const broken = await routes(root, ["--hooks", "--since", "broken.json"])
    expect(broken.ok).toBe(false)
    expect(broken.text).toContain("broken.json is not a saved hook report")
    const missing = await routes(root, ["--hooks", "--since", "absent.json"])
    expect(missing.ok).toBe(false)
  })

  test("refuses --since without --hooks, and --hooks with another mode", async () => {
    const spec = findCommandSpec("routes")
    if (spec === undefined) throw new Error("routes command missing")
    expect(() => bindCommandArgv(spec, ["--since", "x.json"])).toThrow("needs hooks")
    expect(() => bindCommandArgv(spec, ["--hooks", "--graph"])).toThrow("cannot be combined")
  })
})

describe("hook report diff", () => {
  test("counts a hook that runs twice as two entries", () => {
    const before = report({ "GET /a": ["log", "log"], "GET /gone": ["log"] })
    const after = report({ "GET /a": ["log"], "POST /new": ["log"] })
    expect(diffHookReports(before, after)).toEqual([
      { target: "GET /a", added: [], removed: ["onRequest log (app)"] },
      { target: "GET /gone", added: [], removed: ["onRequest log (app)"] },
      { target: "POST /new", added: ["onRequest log (app)"], removed: [] },
    ])
    expect(renderHookDiff(diffHookReports(before, before))).toBe("hook scope unchanged")
  })

  test("a report with no recorded origins says why", () => {
    expect(renderHookReport({ ...report({ "GET /a": [] }), complete: false })).toContain(
      "origins are recorded only outside production builds",
    )
    expect(renderHookReport(report({}))).toBe("no backend routes to report hooks for")
  })

  test("parses only a report-shaped document", () => {
    expect(parseHookReport("not json")).toBeUndefined()
    expect(parseHookReport('{"complete":true,"routes":[],"unmatched":[{}]}')).toBeUndefined()
    expect(
      parseHookReport(
        '{"complete":true,"routes":[{"method":"GET","path":"/","hooks":[{"kind":"onRequest","name":1,"site":"app"}]}],"unmatched":[]}',
      ),
    ).toBeUndefined()
    expect(parseHookReport(JSON.stringify(report({ "GET /": ["x"] })))).toEqual(
      report({ "GET /": ["x"] }),
    )
  })
})

test("nifra check --json carries the hook report of the assurance source", async () => {
  const root = project("check-")
  writeAppFile(
    root,
    "nifra.assurance.ts",
    `import { defineAssuranceConfig } from "@nifrajs/core/assurance"
import { backend } from "./backend/app.ts"
export default defineAssuranceConfig({
  source: backend,
  policy: { rules: [{ name: "all", match: {}, require: [] }] },
})
`,
  )
  const result = await collectCheckResult(root, { lintsOnly: true })
  expect(result.hooks?.routes.map((row) => `${row.method} ${row.path}`)).toEqual([
    "GET /admin/stats",
    "GET /health",
    "GET /users",
  ])
  const capped = await collectCheckResult(root, { lintsOnly: true, maxDiagnostics: 5 })
  expect(capped.hooks).toBeUndefined()
})

describe("nifra upgrade --write", () => {
  const capture = async (run: () => Promise<boolean>) => {
    const lines: string[] = []
    const log = spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")))
    const error = spyOn(console, "error").mockImplementation((...args) =>
      lines.push(args.join(" ")),
    )
    try {
      return { result: await run(), out: lines.join("\n") }
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  }
  const upgradable = (name: string): string => {
    const root = project(name)
    writeAppFile(
      root,
      "package.json",
      JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "^4.0.0" } }),
    )
    return root
  }

  test("saves the pre-upgrade hook report and prints the scope diff", async () => {
    const root = upgradable("upgrade-")
    const { result, out } = await capture(() =>
      runUpgrade(root, { version: "4.0.2", cliVersion: "4.0.2", write: true, verify: false }),
    )
    expect(result).toBe(true)
    expect(out).toContain(
      "Hook scope across the edits (nifra routes --hooks):\n  hook scope unchanged",
    )
    expect(out).toContain(`nifra routes --hooks --since ${HOOKS_BEFORE_UPGRADE_FILE}`)
    const saved = parseHookReport(await readFile(join(root, HOOKS_BEFORE_UPGRADE_FILE), "utf8"))
    expect(saved?.routes.length).toBe(3)
  }, 30_000)

  test("--no-hooks leaves hook scope out", async () => {
    const root = upgradable("upgrade-no-hooks-")
    const { result, out } = await capture(() =>
      runUpgrade(root, {
        version: "4.0.2",
        cliVersion: "4.0.2",
        write: true,
        verify: false,
        hooks: false,
      }),
    )
    expect(result).toBe(true)
    expect(out).not.toContain("Hook scope")
    expect(await Bun.file(join(root, HOOKS_BEFORE_UPGRADE_FILE)).exists()).toBe(false)
  })
})
