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
        count: 6,
        reason:
          "a mkdtemp entry directory, and outDir/workDir (or _prerendered inside outDir) after assertDisposableDir",
      },
      "packages/web/src/deployment-adapter.ts": {
        count: 2,
        reason:
          "a mkdtemp stage and its moved backup, after assertDisposableDir protects the app and build working directory",
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
      "packages/core/src/server/server.ts": {
        count: 2,
        reason: "a source that hands the bounded readers the readers of the request it wraps",
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
    allowed: {
      "packages/web/src/internal/output-guard.ts": {
        count: 1,
        reason:
          "the object projector: only JSON.stringify'd schema key names reach the source; never in an edge bundle or a browser",
      },
    },
  },
  {
    id: "path-encoder",
    why: "five path encoders kept different characters raw, so one page was linked, prerendered and cached under different spellings; a path segment goes through encodePathSegment",
    pattern: /\bencodeURI(?:Component)?\b/g,
    scope: SHIPPED,
    allowed: {
      "packages/core/src/router/path-codec.ts": {
        count: 1,
        reason: "the codec: the non-ASCII runs of a segment",
      },
      "packages/core/src/router/pattern.ts": {
        count: 1,
        reason:
          "literal text a route author wrote, so it matches the request spelling; only controls, space and non-ASCII",
      },
      "packages/agent/src/events.ts": { count: 1, reason: "a storage key prefix, never a URL" },
      "packages/core/src/durable-adapters.ts": { count: 3, reason: "storage keys, never URLs" },
      "packages/web/src/isr.ts": { count: 1, reason: "a KV key" },
      "packages/web/src/internal/ppr/compile-shell.ts": { count: 1, reason: "a bundler entry id" },
      "packages/web/src/live/hub-protocol.ts": {
        count: 2,
        reason: "an app id inside a space-separated token, compared in the same form",
      },
      "packages/core/src/server/cookies.ts": { count: 1, reason: "a cookie value" },
      "packages/i18n/src/cookie.ts": { count: 1, reason: "a cookie value" },
      "packages/web/src/internal/progressive-cookies.ts": { count: 1, reason: "a cookie value" },
      "packages/core/src/binary.ts": { count: 2, reason: "a Content-Disposition filename*" },
      "packages/content/src/index.ts": { count: 1, reason: "a cursor, a query-string value" },
      "packages/web/src/fonts-google.ts": { count: 2, reason: "query-string values" },
      "packages/web/src/href.ts": {
        count: 1,
        reason: "the hash, a fragment the router never matches",
      },
      "packages/web/src/route-slots.ts": {
        count: 1,
        reason:
          "a route target embedded as a query value; encoding its slashes keeps query delimiters inert",
      },
      "packages/web/src/internal/ppr/contract.ts": { count: 2, reason: "query-string pairs" },
      "packages/web/src/internal/secret-scan.ts": {
        count: 1,
        reason: "a variant of a secret value to look for in output",
      },
      "packages/authjs/src/client.ts": {
        count: 3,
        reason:
          "a configured provider slug and the callbackUrl query; the Auth.js server decodes both",
      },
      "packages/middleware/src/problem-details.ts": {
        count: 1,
        reason: "an error code appended to the configured type URI, not a routed path",
      },
    },
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
  {
    id: "href-brand-cast",
    why: "an Href cast onto a string skips the route table and the same-origin check that href() and rawHref() run; shipped code builds one with them",
    pattern: /\bas\s+Href\b/g,
    scope: SHIPPED,
    allowed: {
      "packages/web/src/href.ts": { count: 1, reason: "the one place the brand is applied" },
    },
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
    "path-encoder": "const s = encodeURIComponent(value)",
    // Split so this file's own source does not match the rules it declares.
    "wall-clock-deadline": `{ deadlineAt: Date.now()${" + 5"} }`,
    "sub-second-elapsed-bound": `expect(performance.now() - started)${".toBeLessThan(200)"}`,
    "href-brand-cast": "const to = value as Href",
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
  expect("Date.now() + 60_000".match(RULES[8]?.pattern ?? /$^/)).toBeNull()
  expect(
    "(performance.now() - started).toBeLessThan(1_000)".match(RULES[9]?.pattern ?? /$^/),
  ).toBeNull()
  expect(
    "decodeURIComponent(segment) // not encodeRoute".match(RULES[7]?.pattern ?? /$^/),
  ).toBeNull()
  expect(
    "const to = value as unknown as Href<'/a'>".match(RULES[10]?.pattern ?? /$^/),
  ).not.toBeNull()
  expect("import type { Href } from './navigation.ts'".match(RULES[10]?.pattern ?? /$^/)).toBeNull()
})
