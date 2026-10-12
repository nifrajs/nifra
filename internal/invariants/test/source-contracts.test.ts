/**
 * Patterns behind fixed defects, held out of shipped source, and timing patterns behind flaky
 * tests, held out of the suites. Each rule names the defect class it keeps out. A file may use a pattern only as many times as its entry says, with the reason it is
 * safe there: a new use anywhere, or one more in an allowed file, fails until someone reviews it,
 * and an entry whose uses are gone fails until it is removed.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..", "..")

interface Rule {
  readonly id: string
  /** The defect class this rule keeps out. */
  readonly why: string
  readonly pattern: RegExp
  readonly scope: readonly string[]
  readonly allowed: Readonly<Record<string, { readonly count: number; readonly reason: string }>>
}

const SHIPPED = ["packages/*/src/**/*.{ts,tsx,mts}"]
const TESTS = [
  "packages/*/test/**/*.{ts,tsx}",
  "packages/*/test-node/**/*.ts",
  "scripts/**/*.test.ts",
  "internal/*/test/**/*.ts",
]

const RULES: readonly Rule[] = [
  {
    id: "recursive-delete",
    why: "a build deleted the app's sources when outDir named them",
    pattern: /\b(?:rm|rmSync)\([\s\S]{0,160}?recursive:\s*true/g,
    scope: SHIPPED,
    allowed: {
      "packages/cli/src/assure-hydration.ts": { count: 3, reason: "a mkdtemp work directory" },
      "packages/cli/src/release-verification.ts": { count: 1, reason: "a mkdtemp fixture root" },
      "packages/cli/src/openapi-types.ts": { count: 1, reason: "a mkdtemp scratch directory" },
      "packages/cli/src/output-schemas.ts": { count: 1, reason: "a mkdtemp scratch directory" },
      "packages/web/src/build-vite.ts": {
        count: 2,
        reason: "a mkdtemp entry directory, and .vite inside the outDir buildTargetWith checked",
      },
      "packages/web/src/dev.ts": { count: 1, reason: "the fixed dev directory under the app root" },
      "packages/web/src/build.ts": {
        count: 5,
        reason: "a mkdtemp entry directory, and outDir/workDir after assertDisposableDir",
      },
      "packages/web/src/server-components/build.ts": {
        count: 2,
        reason: "a mkdtemp stage and its backup, after assertDisposableDir on outDir",
      },
      "packages/web/src/server-components/build-target.ts": {
        count: 6,
        reason: "subdirectories of the mkdtemp stage its only caller passes; not exported",
      },
    },
  },
  {
    id: "monotonic-epoch",
    why: "performance.timeOrigin + now() lags wall time by any host sleep, so it misorders across processes",
    pattern: /performance\.timeOrigin/g,
    scope: SHIPPED,
    allowed: {
      "packages/cache/src/cache.ts": {
        count: 1,
        reason:
          "an observer event's start, stamped as OpenTelemetry stamps spans; nothing orders by it",
      },
    },
  },
  {
    id: "forwarded-client-ip",
    why: "a client-settable header was trusted as the caller's address",
    pattern: /["'](?:x-forwarded-for|cf-connecting-ip|x-real-ip|true-client-ip)["']/g,
    scope: SHIPPED,
    allowed: {
      "packages/core/src/server/client-ip.ts": {
        count: 1,
        reason: "walks only the hops the server was told to trust",
      },
      "packages/middleware/src/ip-restriction.ts": {
        count: 1,
        reason: "read only when trustedProxies > 0",
      },
      "packages/middleware/src/rate-limit.ts": {
        count: 2,
        reason: "read only when trustedProxies > 0",
      },
      "packages/proxy/src/index.ts": {
        count: 7,
        reason: "drops or rewrites inbound forwarding headers before the hop",
      },
      "packages/web/src/build.ts": {
        count: 2,
        reason: "names the platform's header for the opt-in clientIp = platform",
      },
    },
  },
  {
    id: "tooling-binds-hostname",
    why: "a developer tool listened on every interface",
    pattern: /Bun\.serve\(\{(?![\s\S]{0,240}?\bhostname\b)/g,
    scope: [
      "packages/cli/src/**/*.ts",
      "packages/coding-agent/src/**/*.ts",
      "packages/devtools/src/**/*.ts",
      "packages/web/src/dev*.ts",
    ],
    allowed: {
      "packages/cli/src/cli.ts": {
        count: 1,
        reason: "docs-mcp is the public docs server, meant to self-host behind a proxy",
      },
    },
  },
  {
    id: "unbounded-body-read",
    why: "a request body was buffered whole, with no byte cap",
    pattern:
      /^(?!\s*(?:\*|\/\/)).*\b(?:req|request|c\.req)\.(?:text|json|arrayBuffer|formData|blob)\(\)/gm,
    scope: SHIPPED,
    allowed: {
      "packages/core/src/tool-contract.ts": {
        count: 1,
        reason: "only when the tool's options turn the byte cap off",
      },
      "packages/core/src/server/body.ts": {
        count: 1,
        reason: "the bounded body reader itself, past its length check",
      },
      "packages/testing/src/certification.ts": { count: 1, reason: "test tooling" },
      "packages/testing/src/contract-lab.ts": { count: 1, reason: "test tooling" },
      "packages/create-nifra/src/agents.ts": { count: 1, reason: "prose in generated guidance" },
    },
  },
  {
    id: "shell-spawn",
    why: "spawning through a shell turns interpolated input into commands",
    pattern: /\bshell:\s*true\b/g,
    scope: SHIPPED,
    allowed: {},
  },
  {
    id: "dynamic-code",
    why: "eval and new Function run data as code",
    pattern: /(?<![.\w])eval\(|\bnew Function\(/g,
    scope: SHIPPED,
    allowed: {},
  },
  {
    id: "wall-clock-deadline",
    why: "a test deadline a few ms past Date.now() expired on a loaded host before the code ran; inject the clock",
    pattern: /Date\.now\(\)\s*\+\s*\d{1,3}\b/g,
    scope: TESTS,
    allowed: {},
  },
  {
    id: "sub-second-elapsed-bound",
    why: "an elapsed-time bound under a second failed on a loaded host with no regression; grow the input until the slow version takes seconds",
    pattern:
      /(?:performance|Date)\.now\(\)\s*-\s*[\w.]+\)\s*\.toBeLessThan(?:OrEqual)?\(\s*\d{1,3}\s*\)/g,
    scope: TESTS,
    allowed: {},
  },
]

function scan(rule: Rule): Map<string, number> {
  const hits = new Map<string, number>()
  for (const glob of rule.scope) {
    for (const file of new Bun.Glob(glob).scanSync({ cwd: ROOT })) {
      if (file.endsWith(".d.ts") || file.includes("/fixtures/") || hits.has(file)) continue
      const count = readFileSync(join(ROOT, file), "utf8").match(rule.pattern)?.length ?? 0
      if (count > 0) hits.set(file, count)
    }
  }
  return hits
}

for (const rule of RULES) {
  test(`${rule.id}: ${rule.why}`, () => {
    const hits = scan(rule)
    const unexpected = [...hits]
      .filter(([file, count]) => rule.allowed[file]?.count !== count)
      .map(([file, count]) => `${file}: ${count} (allowed ${rule.allowed[file]?.count ?? 0})`)
    const stale = Object.keys(rule.allowed).filter((file) => !hits.has(file))
    expect({ unexpected: unexpected.sort(), stale }).toEqual({ unexpected: [], stale: [] })
  })
}

test("every rule matches what it is meant to match", () => {
  const samples: Readonly<Record<string, string>> = {
    "recursive-delete": "rmSync(join(a, b), {\n  recursive: true,\n})",
    "monotonic-epoch": "const t = performance.timeOrigin + performance.now()",
    "forwarded-client-ip": 'req.headers.get("x-forwarded-for")',
    "tooling-binds-hostname": "Bun.serve({ port, fetch })",
    "unbounded-body-read": "  const body = await c.req.json()",
    "shell-spawn": "spawn(cmd, { shell: true })",
    "dynamic-code": "const f = new Function(src)",
    // Split so this file's own source does not match the rules it declares.
    "wall-clock-deadline": `{ deadlineAt: Date.now()${" + 5"} }`,
    "sub-second-elapsed-bound": `expect(performance.now() - started)${".toBeLessThan(200)"}`,
  }
  for (const rule of RULES) {
    const sample = samples[rule.id] ?? ""
    expect({ rule: rule.id, matches: (sample.match(rule.pattern)?.length ?? 0) > 0 }).toEqual({
      rule: rule.id,
      matches: true,
    })
  }
  expect("Bun.serve({ hostname: '127.0.0.1', port })".match(RULES[3]?.pattern ?? /$^/)).toBeNull()
  expect(" * the handler's `c.req.json()` reads".match(RULES[4]?.pattern ?? /$^/)).toBeNull()
  expect("Date.now() + 60_000".match(RULES[7]?.pattern ?? /$^/)).toBeNull()
  expect(
    "(performance.now() - started).toBeLessThan(1_000)".match(RULES[8]?.pattern ?? /$^/),
  ).toBeNull()
})
