import { describe, expect, test } from "bun:test"
import { parseCompatibleReplayFile } from "@nifrajs/core/replay"
import { runRuleRegistry } from "../src/rules/index.ts"
import { securityRules } from "../src/rules/security.ts"
import { projectFacts } from "./rule-facts.ts"

async function scan(file: string, content: string) {
  const facts = projectFacts(file, content)
  return runRuleRegistry(
    {
      root: "/tmp/project",
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

describe("NF-S002 severity by file role", () => {
  const compare = "if (token === expected) deny()"

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

  test("browser code comparisons are advisory", async () => {
    for (const file of ["routes/login.tsx", "frontend/Login.tsx", "app/Form.frontend.jsx"]) {
      const findings = await scan(file, compare)
      expect(findings.find((f) => f.code === "NF-S002")?.severity).toBe("warn")
    }
  })

  test("a route's backend half is server code although it sits in routes/", async () => {
    const findings = await scan("routes/session.backend.ts", compare)
    expect(findings.find((f) => f.code === "NF-S002")?.severity).toBe("error")
  })

  test("treats client-side password confirmation pairs as local validation", async () => {
    const findings = await scan(
      "frontend/ConfirmPassword.tsx",
      [
        "if (password !== confirm) return false",
        "if (password !== confirmPassword) return false",
        "if (input.password === input.passwordConfirmation) return true",
        "if (password === expectedPassword) return false",
      ].join("\n"),
    )

    expect(findings.filter((finding) => finding.code === "NF-S002").map((f) => f.line)).toEqual([4])
    expect(findings.find((finding) => finding.code === "NF-S002")?.severity).toBe("warn")
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
