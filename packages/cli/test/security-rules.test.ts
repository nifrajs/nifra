import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseCompatibleReplayFile } from "@nifrajs/core/replay"
import { runRuleRegistry } from "../src/rules/index.ts"
import { securityRules } from "../src/rules/security.ts"
import { projectFacts } from "./rule-facts.ts"

async function scan(file: string, content: string, root = "/tmp/project") {
  const facts = projectFacts(file, content)
  return runRuleRegistry(
    {
      root,
      sources: facts.source,
      project: facts,
    },
    securityRules,
  )
}

describe("built-in security rules", () => {
  test("flags fail-open catches, secret comparisons, and PII logs", async () => {
    const findings = await scan(
      "routes/security.ts",
      [
        "function requireAuth() { try { check() } catch { return } }",
        "const token = input.token",
        "if (token === expected) console.log(email)",
      ].join("\n"),
    )
    expect(findings.map((finding) => finding.code)).toEqual(["NF-S001", "NF-S002", "NF-S003"])
    expect(findings.find((finding) => finding.code === "NF-S002")?.fix?.recipe).toBe(
      "security.timing-safe-equal",
    )
  })

  test("a generic arrow in a .ts file does not hide the code after it", async () => {
    // Parsed as TSX, `<T>(items: T[])` opens a JSX element and recovery drops the rest of the file.
    const findings = await scan(
      "routes/generic.ts",
      [
        "const first = <T>(items: T[]): T | undefined => items[0]",
        "const token = input.token",
        "if (token === expected) load(first([token]))",
      ].join("\n"),
    )
    expect(findings.map((finding) => finding.code)).toContain("NF-S002")
  })

  test("skips presence and typeof checks on secret-like names", async () => {
    const findings = await scan(
      "routes/presence.ts",
      [
        "if (token === undefined) return",
        "if (secret == null) return",
        'if (apiKey !== "") load(apiKey)',
        'if (typeof password === "string") load(password)',
      ].join("\n"),
    )
    expect(findings.filter((finding) => finding.code === "NF-S002")).toEqual([])
  })

  test("keeps reviewed overrides visible without failing", async () => {
    const findings = await scan(
      "routes/security.ts",
      [
        "const token = input.token",
        "// @nifra-gate-reviewed",
        "if (token === expected) console.log(token)",
      ].join("\n"),
    )
    expect(findings.every((finding) => finding.severity === "info")).toBe(true)
    expect(findings.every((finding) => finding.evidence?.includes("@nifra-gate-reviewed"))).toBe(
      true,
    )
  })

  test("NF-S001 gate-name: `can` needs camelCase, so canonical/cancel are not gates", async () => {
    const findings = await scan(
      "routes/names.server.ts",
      [
        "function canonicalizeBody() { try { parse() } catch { return raw } }",
        "function canEdit() { try { check() } catch { return } }",
      ].join("\n"),
    )
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual(["NF-S001:2"])
  })

  test("NF-S001 names an arrow or function expression by the binding it is assigned to", async () => {
    const findings = await scan(
      "backend/gates.ts",
      [
        "const requireAuth = async () => { try { await check() } catch { return true } }",
        "const canEdit = function () { try { check() } catch { return true } }",
        "export const gates = { authorizeAdmin: (user) => { try { check(user) } catch {} } }",
        "const loadProfile = async () => { try { await load() } catch { return null } }",
      ].join("\n"),
    )
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual([
      "NF-S001:1",
      "NF-S001:2",
      "NF-S001:3",
    ])
  })

  test("NF-S001 delegated denial: a catch that calls fail() is not fail-open", async () => {
    const findings = await scan(
      "routes/assert.server.ts",
      [
        "function assertConformance() { try { render() } catch (e) { fail('render', e) } }",
        "function requireAuth() { try { check() } catch { logger.warn('oops') } }",
      ].join("\n"),
    )
    // fail() delegates the denial; the plain logger.warn catch is still fail-open.
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual(["NF-S001:2"])
  })

  test("NF-S002 skips enum-member accesses (ts.SyntaxKind.PlusToken is a kind, not a secret)", async () => {
    const findings = await scan(
      "scanner.server.ts",
      [
        "if (node.operator === ts.SyntaxKind.PlusPlusToken) bump()",
        "if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) fold()",
        "if (token === expected) load()",
      ].join("\n"),
    )
    // Only the camelCase secret compare on line 3 survives; the enum discriminants do not.
    expect(findings.filter((finding) => finding.code === "NF-S002").map((f) => f.line)).toEqual([3])
  })

  test("NF-S002 flags a secret read from configuration by its UPPER_SNAKE name", async () => {
    const findings = await scan(
      "backend/webhook.ts",
      [
        "if (header === process.env.API_TOKEN) ok()",
        "if (header === Bun.env.WEBHOOK_SECRET) ok()",
        'if (header === process.env["API_KEY"]) ok()',
        "if (header === env.HMAC_SECRET) ok()",
        "if (kind === ts.SyntaxKind.PlusToken) ok()",
      ].join("\n"),
    )
    expect(findings.filter((finding) => finding.code === "NF-S002").map((f) => f.line)).toEqual([
      1, 2, 3, 4,
    ])
  })

  test("NF-S002 skips comparisons against a numeric literal (length/version, not a secret)", async () => {
    const findings = await scan(
      "manifest.server.ts",
      [
        "if (candidate.signature !== 1) return false",
        "if (signatureLength !== 64) return false",
        "if (token === expected) load()",
      ].join("\n"),
    )
    // Only the string-vs-string secret compare on line 3 survives.
    expect(findings.filter((finding) => finding.code === "NF-S002").map((f) => f.line)).toEqual([3])
  })
})

describe("configuration audit rules (NF-S004..007)", () => {
  test("flags CORS origin predicates that never read the origin", async () => {
    const findings = await scan(
      "app.ts",
      [
        "app.use(cors({ origin: () => true }))",
        "app.use(cors({ origin: (o) => true }))",
        "app.use(cors({ origin: (o) => allowed.has(o) }))",
        'app.use(cors({ origin: ["https://app.example"] }))',
      ].join("\n"),
    )
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual([
      "NF-S004:1",
      "NF-S004:2",
    ])
    expect(findings.every((finding) => finding.severity === "warn")).toBe(true)
  })

  test("flags external redirects, not internal ones", async () => {
    const findings = await scan(
      "routes/out.ts",
      [
        "return redirect(target, { external: true })",
        'return redirect("/home")',
        "return redirect(url, { status: 302 })",
      ].join("\n"),
    )
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual(["NF-S005:1"])
    expect(findings[0]?.severity).toBe("warn")
  })

  test("flags assurance escape hatches and names the weakened claim", async () => {
    const findings = await scan(
      "app.ts",
      [
        "app.use(bodyLimit({ maxBytes: 1024, allowLengthless: true }))",
        "app.use(rateLimit({ limit: 5, allowGlobalKey: true }))",
        "const store = new MemoryStore({ allowInProduction: true })",
        "app.use(bodyLimit({ maxBytes: 1024, allowLengthless: false }))",
      ].join("\n"),
    )
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual([
      "NF-S006:1",
      "NF-S006:2",
      "NF-S006:3",
    ])
    expect(findings[0]?.message).toContain("BODY_BOUNDED")
    expect(findings[1]?.message).toContain("shared bucket")
    expect(findings[2]?.message).toContain("per-instance")
  })

  test("nudges Secure cookies toward __Host-/__Secure- prefixes", async () => {
    const findings = await scan(
      "routes/login.ts",
      [
        'ctx.cookie("session", value, { secure: true, httpOnly: true })',
        'ctx.cookie("__Host-session", value, { secure: true, httpOnly: true })',
        'serializeCookie("theme", value, { path: "/" })',
        "ctx.cookie(name, value, { secure: true })",
      ].join("\n"),
    )
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual(["NF-S007:1"])
    expect(findings[0]?.severity).toBe("info")
  })

  test("reviewed marker downgrades the audit rules", async () => {
    const findings = await scan(
      "app.ts",
      [
        "// @nifra-gate-reviewed",
        "app.use(cors({ origin: () => true }))",
        "// @nifra-gate-reviewed",
        "return redirect(target, { external: true })",
        "// @nifra-gate-reviewed",
        "app.use(bodyLimit({ allowLengthless: true }))",
      ].join("\n"),
    )
    expect(findings.map((finding) => finding.code).sort()).toEqual([
      "NF-S004",
      "NF-S005",
      "NF-S006",
    ])
    expect(findings.every((finding) => finding.severity === "info")).toBe(true)
  })
})

test("legacy replay metadata remains parseable", () => {
  expect(parseCompatibleReplayFile({ seed: 7, caseId: "GET /", runtime: "bun" })).toEqual({
    seed: 7,
    caseId: "GET /",
    runtime: "bun",
  })
  expect(parseCompatibleReplayFile({ seed: 7, schedule: [] })).toEqual({ seed: 7, schedule: [] })
})

test("shares source reads across built-in security rules", async () => {
  let reads = 0
  const content = [
    "function requireAuth() { try { check() } catch { return } }",
    "const token = input.token",
    "if (token === expected) console.log(email)",
  ].join("\n")
  const baseFacts = projectFacts("routes/security.ts", content)
  const source = {
    files: ["routes/security.ts"],
    read: () => {
      reads += 1
      return content
    },
  }
  const facts = { ...baseFacts, source }
  const findings = await runRuleRegistry(
    {
      root: "/tmp/project",
      sources: facts.source,
      project: facts,
    },
    securityRules,
  )
  expect(findings.map((finding) => finding.code)).toEqual(["NF-S001", "NF-S002", "NF-S003"])
  expect(reads).toBe(1)
})

const projects: string[] = []
afterAll(() => {
  for (const root of projects) rmSync(root, { recursive: true, force: true })
})

/** A project on disk holding only `files` (path to content), so web-app detection reads real files. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nifra-s002-"))
  projects.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const manifest = (dependencies: Record<string, string>) => JSON.stringify({ dependencies })
const webApp = () => project({ "nifra.config.ts": "export default {}" })

describe("NF-S002 precision", () => {
  const linesOf = async (content: string) =>
    (await scan("server/auth.ts", content)).filter((f) => f.code === "NF-S002").map((f) => f.line)

  test("a comparison against a boolean is a flag check", async () => {
    expect(
      await linesOf(
        [
          "if (persistRefreshToken === true) keep()",
          "if (options.persistRefreshToken !== false) keep()",
          "if (true == hasToken) keep()",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("a name whose last word states a fact about the secret is not secret material", async () => {
    const names = [
      "tokenType",
      "secretKind",
      "apiKeyName",
      "apiKeyHeaderName",
      "TOKEN_HEADER_NAME",
      "tokenId",
      "apiKeyIds",
      "passwordLength",
      "secretLen",
      "tokenCount",
      "secretSize",
      "signatureMode",
      "passwordPolicy",
      "tokenVersion",
      "SECRET_CAP_SQLSTATE",
      "tokenStatus",
      "hmacEnabled",
      "passwordRequired",
      "tokenTTL",
      "tokenExpiry",
      "tokenExpires",
    ]
    expect(await linesOf(names.map((name) => `if (${name} === input) x()`).join("\n"))).toEqual([])
    expect(await linesOf("if (error.code === SECRET_CAP_SQLSTATE) retry()")).toEqual([])
  })

  test("the secret word anywhere but the last word still flags", async () => {
    const names = [
      "tokenValue",
      "passwordHash",
      "secretBytes",
      "apiKeyHeader",
      "secretCode",
      "webhookSecretPath",
      "tokenPrefix",
      "signatureHex",
      "tokenIdHash",
    ]
    expect(await linesOf(names.map((name) => `if (${name} === input) x()`).join("\n"))).toEqual(
      names.map((_, index) => index + 1),
    )
  })

  test("two configuration reads are no timing oracle", async () => {
    expect(
      await linesOf(
        [
          "if (process.env.JWT_SECRET === process.env.SESSION_SECRET) throw new Error('keys must differ')",
          "if (Bun.env.A_TOKEN === process.env['B_TOKEN']) throw new Error('keys must differ')",
          "if (Deno.env.get('A_SECRET') !== import.meta.env.B_SECRET) ok()",
          "function boot(env: Env) { if (env.JWT_SECRET === env.SESSION_SECRET) throw new Error('x') }",
          "app.get('/', (c) => c.env.A_TOKEN === c.env.B_TOKEN)",
          "export default { fetch(req: Request, env: Env) { return env.A_SECRET == env.B_SECRET } }",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("a configuration read compared with anything else still flags", async () => {
    expect(
      await linesOf(
        [
          "if (token === header) x()",
          "if (secret == input) x()",
          'if (apiKey !== req.headers.get("x-api-key")) x()',
          "if (signatureHex === expected) x()",
          'const API_TOKEN = "hard-coded"',
          "if (API_TOKEN === input) x()",
          'if (process.env.API_TOKEN === req.headers.get("x-token")) x()',
          "const env = { A_TOKEN: input, B_TOKEN: other }",
          "if (env.A_TOKEN === env.B_TOKEN) x()",
          "function f(env: Env, list: Env[]) { for (const env of list) if (env.A_TOKEN === env.B_TOKEN) x() }",
          "function g(env: Env) { { const env = build(); if (env.A_TOKEN === env.B_TOKEN) x() } }",
          "function h({ env }: Ctx) { if (env.A_TOKEN === env.B_TOKEN) x() }",
          "if (body.env.API_TOKEN === process.env.API_TOKEN) x()",
          "const c = parse(input); if (c.env.A_TOKEN === c.env.B_TOKEN) x()",
          "app.get('/', (c) => c.env.apiToken === c.env.otherToken)",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14, 15])
  })
})

describe("NF-S002 severity by file role", () => {
  const compare = "if (token === expected) deny()"
  const severityOf = async (file: string, root: string) =>
    (await scan(file, compare, root)).find((f) => f.code === "NF-S002")?.severity

  test("server-side comparisons fail the gate", async () => {
    for (const file of [
      "backend/verify.ts",
      "routes/login.backend.ts",
      "shared/hmac.ts",
      "lib/hmac.ts",
      "routes/legacy.server.ts",
    ]) {
      const findings = await scan(file, compare)
      expect(findings.find((f) => f.code === "NF-S002")?.severity).toBe("error")
    }
  })

  test("browser code in a web app is advisory", async () => {
    const root = webApp()
    for (const file of ["routes/login.tsx", "frontend/Login.tsx", "app/Form.frontend.jsx"]) {
      expect(await severityOf(file, root)).toBe("warn")
    }
  })

  test("each web app marker proves a web app", async () => {
    for (const files of [
      { "backend/framework.ts": "export {}" },
      { "package.json": manifest({ "@nifrajs/web": "5.0.0" }) },
      { "package.json": manifest({ "@nifrajs/web-react": "5.0.0" }) },
    ]) {
      expect(await severityOf("routes/login.tsx", project(files))).toBe("warn")
    }
  })

  test("routes/ in an API-only project is server code", async () => {
    const root = project({ "package.json": manifest({ "@nifrajs/core": "5.0.0" }) })
    expect(await severityOf("src/routes/auth.ts", root)).toBe("error")
    expect(await severityOf("routes/auth.ts", "/tmp/project")).toBe("error")
  })

  test("the nearest package.json decides, so a web dependency at the root covers no other package", async () => {
    const root = project({
      "package.json": manifest({ "@nifrajs/web": "5.0.0" }),
      "apps/site/nifra.config.ts": "export default {}",
      "packages/api/package.json": manifest({ "@nifrajs/core": "5.0.0" }),
      "packages/shared/package.json": manifest({}),
    })
    expect(await severityOf("apps/site/routes/login.tsx", root)).toBe("warn")
    expect(await severityOf("packages/api/src/routes/auth.ts", root)).toBe("error")
    expect(await severityOf("packages/shared/x.ts", root)).toBe("error")
    expect(await severityOf("packages/shared/frontend/x.tsx", root)).toBe("error")
  })

  test("an unreadable or malformed package.json proves nothing", async () => {
    for (const text of ["{", "null", JSON.stringify({ dependencies: "@nifrajs/web" })]) {
      expect(await severityOf("routes/login.tsx", project({ "package.json": text }))).toBe("error")
    }
  })

  test("a route's backend half is server code although it sits in routes/", async () => {
    const findings = await scan("routes/session.backend.ts", compare)
    expect(findings.find((f) => f.code === "NF-S002")?.severity).toBe("error")
  })

  test("treats client-side password confirmation pairs as local validation", async () => {
    const confirmations = [
      "if (password !== confirm) return false",
      "if (password !== confirmPassword) return false",
      "if (input.password === input.passwordConfirmation) return true",
      "if (password === expectedPassword) return false",
    ].join("\n")
    const findings = await scan("frontend/ConfirmPassword.tsx", confirmations, webApp())
    expect(findings.filter((finding) => finding.code === "NF-S002").map((f) => f.line)).toEqual([4])
    expect(findings.find((finding) => finding.code === "NF-S002")?.severity).toBe("warn")

    const outsideWebApp = await scan("frontend/ConfirmPassword.tsx", confirmations)
    expect(
      outsideWebApp.filter((finding) => finding.code === "NF-S002").map((f) => f.severity),
    ).toEqual(["error", "error", "error", "error"])
  })

  test("does not weaken confirmation comparisons on the server", async () => {
    const findings = await scan(
      "routes/auth.backend.ts",
      "if (password !== confirmPassword) return false\nif (password === expectedPassword) return false",
    )

    expect(findings.filter((finding) => finding.code === "NF-S002").map((f) => f.line)).toEqual([
      1, 2,
    ])
    expect(findings.every((finding) => finding.severity === "error")).toBe(true)
  })
})

test("reviewed marker counts anywhere in the comment block above, not only 2 lines up", async () => {
  const findings = await scan(
    "server/auth.ts",
    [
      "// @nifra-gate-reviewed: this compares a public webhook echo, not secret material.",
      "// The upstream signs with a per-delivery nonce; equality here is a routing hint only,",
      "// and the real verification happens in verifySignature() below.",
      "if (token === expected) deny()",
    ].join("\n"),
  )
  const s002 = findings.find((f) => f.code === "NF-S002")
  expect(s002?.severity).toBe("info")
  expect(s002?.evidence).toContain("@nifra-gate-reviewed")
})
