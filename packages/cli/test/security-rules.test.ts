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

  test("keeps expected findings visible, with their reason, without failing", async () => {
    const findings = await scan(
      "routes/security.ts",
      [
        "const token = input.token",
        "// nifra-expect NF-S002: compares a public echo, not secret material",
        "// nifra-expect NF-S003: the token is a public request id",
        "if (token === expected) console.log(token)",
      ].join("\n"),
    )
    expect(findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ["NF-S002", "info"],
      ["NF-S003", "info"],
    ])
    expect(findings.find((f) => f.code === "NF-S002")?.evidence).toContain(
      "nifra-expect NF-S002: compares a public echo, not secret material",
    )
  })

  test("a nifra-expect comment silences only the code it names, and only with a reason", async () => {
    const compare = "if (token === expected) deny()"
    const severity = async (comment: string) =>
      (await scan("server/auth.ts", `${comment}\n${compare}`)).find((f) => f.code === "NF-S002")
    for (const comment of [
      "// nifra-expect NF-S003: names another finding",
      "// nifra-expect NF-S0021: a longer code is another code",
      "// nifra-expect NF-S002",
      "// nifra-expect NF-S002:",
      "// nifra-expect NF-S002:   */",
    ]) {
      expect((await severity(comment))?.severity).toBe("error")
    }
    expect((await severity("// nifra-expect NF-S002"))?.message).toContain("gives no reason")
    expect((await severity("/* nifra-expect NF-S002: a block comment */"))?.evidence).toContain(
      "nifra-expect NF-S002: a block comment",
    )
  })

  test("a nifra-expect inside a string on the flagged line silences nothing; a trailing comment does", async () => {
    const finding = async (line: string) =>
      (await scan("server/auth.ts", line)).find((f) => f.code === "NF-S002")
    for (const line of [
      'const ok = token === expected ? "nifra-expect NF-S002: data, not a comment" : ""',
      "const ok = token === expected || `// nifra-expect NF-S002: in a template`",
      "const ok = token === expected || 'it\\'s // nifra-expect NF-S002: escaped quote'",
    ]) {
      expect((await finding(line))?.severity).toBe("error")
    }
    const trailing = await finding(
      'const ok = token === expected && "a//b" // nifra-expect NF-S002: compares a public echo',
    )
    expect(trailing?.severity).toBe("info")
  })

  test("the retired @nifra-gate-reviewed marker silences nothing and names its replacement", async () => {
    for (const marker of ["// @nifra-gate-reviewed", "// @nifra-gate-reviewed: reviewed"]) {
      const finding = (
        await scan("server/auth.ts", `${marker}\nif (token === expected) deny()`)
      ).find((f) => f.code === "NF-S002")
      expect(finding?.severity).toBe("error")
      expect(finding?.message).toContain("// nifra-expect NF-S002: <reason>")
    }
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

  test("NF-S001 reads the catch's statements, not its words", async () => {
    const findings = await scan(
      "routes/words.server.ts",
      [
        "function requireAuth() { try { check() } catch { /* throw later */ return true } }",
        'function requireRole() { try { check() } catch { log("throw away"); return true } }',
        "function requireUser() { try { check() } catch (e) { setTimeout(() => { throw e }); return true } }",
        'function requireOwner() { try { check() } catch { log("return false"); return true } }',
        "function requireA() { try { check() } catch (e) { if (e) throw e; return true } }",
        "function requireB() { try { check() } catch { return (false) } }",
        "function requireC() { try { check() } catch { return new Response(null, { status: 403 }) } }",
        "async function requireD() { try { check() } catch { return await denyRequest() } }",
        "function requireE() { try { check() } catch (e) { reject(e) } }",
      ].join("\n"),
    )
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual([
      "NF-S001:1",
      "NF-S001:2",
      "NF-S001:3",
      "NF-S001:4",
    ])
  })

  test("NF-S001 counts a result object's false decision and an authenticator's nobody as denials", async () => {
    const findings = await scan(
      "backend/results.ts",
      [
        "function requireA() { try { check() } catch (e) { return { ok: false, error: String(e) } } }",
        'function requireB() { try { check() } catch { return { "allowed": false } } }',
        "function authenticateToken() { try { return read() } catch { return null } }",
        "function authenticateKey() { try { return read() } catch { return undefined } }",
        "function authenticateSession() { try { return read() } catch { return } }",
        "function requireC() { try { check() } catch { return { ok: true } } }",
        "function requireD() { try { check() } catch { return null } }",
        "function authenticateUser() { try { return read() } catch { return { id: 'guest' } } }",
      ].join("\n"),
    )
    expect(findings.map((finding) => `${finding.code}:${finding.line}`)).toEqual([
      "NF-S001:6",
      "NF-S001:7",
      "NF-S001:8",
    ])
  })

  test("NF-S001 knows the names gates go by", async () => {
    const gates = [
      "verifyToken",
      "verifySession",
      "ensureLoggedIn",
      "checkPermission",
      "validateCsrf",
      "authenticate",
      "authoriseUser",
      "adminGuard",
      "checkPermissions",
      "checkAuthorization",
      "verifySignatures",
      "ensureOwnership",
      "checkUserAccess",
    ]
    const other = [
      "ensureDir",
      "checkHealth",
      "verifyChecksum",
      "validateEmail",
      "Guard",
      // The noun ends the gate's name; past it, another word names something else.
      "validateTokenizer",
      "checkAccessibility",
      "validateOriginalUrl",
      "checkUsers",
    ]
    const findings = await scan(
      "backend/names.ts",
      [...gates, ...other]
        .map((name) => `function ${name}() { try { check() } catch { return true } }`)
        .join("\n"),
    )
    expect(findings.map((finding) => finding.line)).toEqual(gates.map((_, index) => index + 1))
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

  test("an app.ws() route that parses its own frames without a messageSchema is named", async () => {
    const findings = await scan(
      "backend/app.ts",
      [
        "app",
        '  .ws("/raw", {',
        "    message(ws, data) {",
        "      const msg = JSON.parse(String(data))",
        "      ws.send(msg.text)",
        "    },",
        "  })",
        '  .ws("/arrow", { message: (ws, data) => ws.send(JSON.parse(String(data)).text) })',
        '  .ws("/typed", { messageSchema: ChatIn, message: (ws, msg) => ws.send(JSON.parse(msg.raw)) })',
        '  .ws("/spread", { ...shared, message: (ws, data) => JSON.parse(String(data)) })',
        '  .ws("/echo", { message: (ws, data) => ws.send(data) })',
        "// nifra-expect NF-S009: frames are forwarded to a validated queue",
        'app.ws("/relay", { message: (ws, data) => queue.push(JSON.parse(String(data))) })',
        "api.chat.ws({ onError: () => JSON.parse('{}') })",
      ].join("\n"),
    )
    const s009 = findings
      .filter((finding) => finding.code === "NF-S009")
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    expect(s009.map((finding) => `${finding.line}:${finding.evidence?.[0]}`)).toEqual([
      "2:/raw",
      "8:/arrow",
      "13:/relay",
    ])
    expect(s009.every((finding) => finding.severity === "info")).toBe(true)
    expect(s009[0]?.message).toContain("declares no messageSchema")
    expect(s009[2]?.message).toContain("is expected here")
  })

  test("a nifra-expect comment downgrades the audit rules", async () => {
    const findings = await scan(
      "app.ts",
      [
        "// nifra-expect NF-S004: a public read-only API",
        "app.use(cors({ origin: () => true }))",
        "// nifra-expect NF-S005: the target is a constant",
        "return redirect(target, { external: true })",
        "// nifra-expect NF-S006: the edge proxy caps every body",
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

describe("NF-S001 severity by file role", () => {
  const gate = (hatch = "") =>
    `function canEdit() {\n  try {\n    check()\n  ${hatch}} catch {\n    toast("not allowed")\n  }\n}\n`
  const finding = async (file: string, root: string, hatch?: string) =>
    (await scan(file, gate(hatch), root)).find((f) => f.code === "NF-S001")

  test("the same fail-open catch is advisory in a web app's browser code and fails everywhere else", async () => {
    const root = webApp()
    for (const file of ["routes/settings.tsx", "frontend/pages/Developers.tsx"]) {
      const found = await finding(file, root)
      expect(found?.severity).toBe("warn")
      expect(found?.evidence).toContain("browser code: the server's own gate decides")
    }
    for (const file of [
      "backend/admin.ts",
      "routes/settings.backend.ts",
      "shared/guard.ts",
      "lib/guard.ts",
    ])
      expect((await finding(file, root))?.severity).toBe("error")
    const api = project({ "package.json": manifest({ "@nifrajs/core": "5.0.0" }) })
    expect((await finding("routes/settings.tsx", api))?.severity).toBe("error")
  })

  test("a reasoned nifra-expect is info everywhere; the retired marker silences nothing", async () => {
    const root = webApp()
    const reviewed =
      "// nifra-expect NF-S001: the toast is the whole effect; the API checks again\n  "
    for (const file of ["routes/settings.tsx", "backend/admin.ts"])
      expect((await finding(file, root, reviewed))?.severity).toBe("info")
    const retired = await finding(
      "routes/settings.tsx",
      root,
      "// @nifra-gate-reviewed: reviewed\n  ",
    )
    expect(retired?.severity).toBe("warn")
    expect(retired?.message).toContain("// nifra-expect NF-S001: <reason>")
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

  test('"nifra": { "kind": "api" } makes every file server code, a web dependency notwithstanding', async () => {
    const root = project({
      "package.json": JSON.stringify({
        nifra: { kind: "api" },
        dependencies: { "@nifrajs/web": "5.0.0" },
      }),
    })
    expect(await severityOf("routes/login.tsx", root)).toBe("error")
    expect(await severityOf("frontend/Login.tsx", root)).toBe("error")
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

test("a nifra-expect comment counts anywhere in the comment block above, not only 2 lines up", async () => {
  const findings = await scan(
    "server/auth.ts",
    [
      "// nifra-expect NF-S002: this compares a public webhook echo, not secret material.",
      "// The upstream signs with a per-delivery nonce; equality here is a routing hint only,",
      "// and the real verification happens in verifySignature() below.",
      "if (token === expected) deny()",
    ].join("\n"),
  )
  const s002 = findings.find((f) => f.code === "NF-S002")
  expect(s002?.severity).toBe("info")
  expect(s002?.evidence).toContain(
    "nifra-expect NF-S002: this compares a public webhook echo, not secret material.",
  )
})
