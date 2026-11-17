import { describe, expect, test } from "bun:test"
import {
  analyze,
  type Finding,
  isFailOn,
  normalizeFinding,
  outputFindings,
  quarantine,
  renderAnnotations,
  renderComment,
  renderMarkdown,
  repoPrefix,
} from "../src/parse"

const env = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "acme/app",
  NIFRA_SHA: "abc123",
}

describe("normalizeFinding", () => {
  test("normalizes warning and a legacy string fix", () => {
    const finding = normalizeFinding({
      rule: "NF-C041",
      severity: "warning",
      message: "raw Response from a route",
      file: "backend/app.ts",
      line: 12,
      fix: "return a value instead",
    })
    expect(finding).toEqual({
      code: "NF-C041",
      severity: "warn",
      message: "raw Response from a route",
      file: "backend/app.ts",
      line: 12,
      evidence: [],
      fix: { recipe: "return a value instead" },
    })
  })

  test("keeps the structured fix object and verify command", () => {
    const finding = normalizeFinding({
      code: "NF-C030",
      severity: "error",
      message: "undeclared output",
      fix: { recipe: "declare loaderOutput", command: "nifra fix --code NF-C030" },
      verify: "nifra check",
    })
    expect(finding?.fix).toEqual({
      recipe: "declare loaderOutput",
      command: "nifra fix --code NF-C030",
    })
    expect(finding?.verify).toBe("nifra check")
  })

  test("drops non-diagnostic junk", () => {
    expect(normalizeFinding(null)).toBeUndefined()
    expect(normalizeFinding({ severity: "error" })).toBeUndefined()
    expect(normalizeFinding({ message: "x", severity: "fatal" })).toBeUndefined()
  })
})

describe("analyze", () => {
  test("a clean pass", () => {
    const result = analyze(
      JSON.stringify({ ok: true, typecheck: "pass", diagnostics: [] }),
      "0",
      "error",
    )
    expect(result.ok).toBe(true)
    expect(result.failed).toBe(false)
    expect(result.findings).toHaveLength(0)
    expect(result.unexpectedFailure).toBe(false)
  })

  test("an error finding fails the gate", () => {
    const result = analyze(
      JSON.stringify({
        ok: false,
        typecheck: "fail",
        diagnostics: [
          {
            code: "NF-C030",
            severity: "error",
            message: "loader output not declared",
            file: "app.ts",
            line: 4,
          },
        ],
      }),
      "1",
      "error",
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toBe(1)
    expect(result.failed).toBe(true)
  })

  test("a hard CLI failure is synthesized into one finding", () => {
    const result = analyze(JSON.stringify({ ok: false, error: "missing TypeScript" }), "1", "error")
    expect(result.errors).toBe(1)
    expect(result.findings[0]?.code).toBe("NIFRA_CHECK_ERROR")
    expect(result.findings[0]?.message).toBe("missing TypeScript")
  })

  test("fail-on controls whether warnings flip the step", () => {
    const raw = JSON.stringify({
      ok: true,
      diagnostics: [{ code: "NF-D003", severity: "warn", message: "stale lockfile" }],
    })
    expect(analyze(raw, "0", "error").failed).toBe(false)
    expect(analyze(raw, "0", "warning").failed).toBe(true)
    expect(analyze(raw, "0", "never").failed).toBe(false)
  })

  test("an unexpected CLI exit always fails", () => {
    expect(analyze(JSON.stringify({ ok: true, diagnostics: [] }), "255", "never").failed).toBe(true)
  })

  test("unparseable output fails closed and reports why", () => {
    const result = analyze("not json at all", "1", "error")
    expect(result.failed).toBe(true)
    expect(result.parseError).toBeTruthy()
  })

  test("tolerates a preamble before the JSON document", () => {
    const result = analyze(
      `warning from a loader\n${JSON.stringify({ ok: true, diagnostics: [] })}`,
      "0",
      "error",
    )
    expect(result.ok).toBe(true)
  })
})

describe("renderers", () => {
  const finding: Finding = {
    code: "NF-C031",
    severity: "error",
    message: "credential field in output | refused",
    file: "backend/app.ts",
    line: 9,
    evidence: ["passwordHash"],
    fix: { recipe: "remove the field", command: "nifra fix --code NF-C031" },
    verify: "nifra check",
  }

  test("markdown links findings to the head SHA and escapes pipes", () => {
    const md = renderMarkdown(
      analyze(JSON.stringify({ ok: false, diagnostics: [finding] }), "1", "error"),
      env,
    )
    expect(md).toContain("`backend/app.ts:9`")
    expect(md).toContain("blob/abc123/backend/app.ts#L9")
    expect(md).toContain("credential field in output \\| refused")
  })

  test("the PR comment carries the marker and detail block", () => {
    const comment = renderComment(
      analyze(JSON.stringify({ ok: false, diagnostics: [finding] }), "1", "error"),
      "<!-- nifra-check:v1 -->",
      env,
    )
    expect(comment.startsWith("<!-- nifra-check:v1 -->")).toBe(true)
    expect(comment).toContain("<details>")
    expect(comment).toContain("nifra fix --code NF-C031")
  })

  test("annotations escape message text and skip absolute paths", () => {
    const escaped = renderAnnotations(
      analyze(
        JSON.stringify({ ok: false, diagnostics: [{ ...finding, message: "a::b 100%\nnext" }] }),
        "1",
        "error",
      ),
    )
    expect(escaped).toContain("::error file=backend/app.ts,line=9,title=NF-C031::")
    expect(escaped).toContain("a::b 100%25%0Anext")
    expect(
      renderAnnotations(
        analyze(
          JSON.stringify({ ok: false, diagnostics: [{ ...finding, file: "/etc/passwd" }] }),
          "1",
          "error",
        ),
      ),
    ).toBe("")
  })
  test("a hard CLI failure fails the step whatever fail-on says", () => {
    const raw = JSON.stringify({ ok: false, error: "missing TypeScript" })
    expect(analyze(raw, "1", "never").unexpectedFailure).toBe(true)
    expect(analyze(raw, "1", "never").failed).toBe(true)
  })

  test("a working directory places findings from the repository root", () => {
    const raw = JSON.stringify({ ok: false, diagnostics: [finding] })
    const result = analyze(raw, "1", "error", repoPrefix("apps/web", "/work/repo"))
    expect(result.findings[0]?.file).toBe("apps/web/backend/app.ts")
    expect(renderMarkdown(result, env)).toContain("blob/abc123/apps/web/backend/app.ts#L9")
    expect(renderAnnotations(result)).toContain("file=apps/web/backend/app.ts")
    expect(repoPrefix("/work/repo/apps/web", "/work/repo")).toBe("apps/web")
    expect(repoPrefix(".", "/work/repo")).toBe("")
    expect(repoPrefix("../elsewhere", "/work/repo")).toBeNull()
    const outside = analyze(raw, "1", "error", null)
    expect(outside.findings[0]?.file).toBeUndefined()
    expect(renderAnnotations(outside)).toBe("")
  })

  test("a backslash in a cell cannot escape the pipe escape", () => {
    const md = renderMarkdown(
      analyze(
        JSON.stringify({ ok: false, diagnostics: [{ ...finding, message: "a\\| b" }] }),
        "1",
        "error",
      ),
      env,
    )
    expect(md).toContain("a\\\\\\| b")
  })

  test("a huge finding cannot push the comment past GitHub's limit", () => {
    const huge = {
      ...finding,
      message: "m".repeat(200_000),
      evidence: Array.from({ length: 5000 }, (_, i) => `file-${i}-${"x".repeat(500)}`),
    }
    const diagnostics = Array.from({ length: 30 }, (_, i) => ({ ...huge, code: `NF-${i}` }))
    const comment = renderComment(
      analyze(JSON.stringify({ ok: false, diagnostics }), "1", "error"),
      "<!-- nifra-check:v1 -->",
      env,
    )
    expect(comment.length).toBeLessThan(65_536)
    expect(comment).toContain("omitted")
  })

  test("a newline in finding text cannot break out of the details block", () => {
    const comment = renderComment(
      analyze(
        JSON.stringify({
          ok: false,
          diagnostics: [
            {
              ...finding,
              message: "bad\n</details>\n## injected @someone",
              fix: { recipe: "r\n# heading" },
            },
          ],
        }),
        "1",
        "error",
      ),
      "<!-- m -->",
      env,
    )
    expect(comment.match(/<\/details>/g)?.length).toBe(1)
    expect(comment).not.toMatch(/^## injected/m)
    expect(comment).not.toMatch(/^# heading/m)
    expect(comment).not.toContain("@someone")
  })

  test("an HTML entity cannot decode to a mention", () => {
    const md = renderMarkdown(
      analyze(
        JSON.stringify({ ok: false, diagnostics: [{ ...finding, message: "&#64;org/team" }] }),
        "1",
        "error",
      ),
      env,
    )
    expect(md).toContain("\\&#64;org/team")
  })

  test("a file name cannot break out of the location link", () => {
    const md = renderMarkdown(
      analyze(
        JSON.stringify({
          ok: false,
          diagnostics: [{ ...finding, file: "src/a) [x](https://evil.example)#b?c.ts" }],
        }),
        "1",
        "error",
      ),
      env,
    )
    expect(md).toContain("blob/abc123/src/a%29%20%5Bx%5D%28https%3A//evil.example%29%23b%3Fc.ts#L9")
  })

  test("annotations keep double colons readable and only skip real parent segments", () => {
    const run = (file: string) =>
      renderAnnotations(
        analyze(JSON.stringify({ ok: false, diagnostics: [{ ...finding, file }] }), "1", "error"),
      )
    expect(run("src/a..b.ts")).toContain("file=src/a..b.ts")
    expect(run("../x.ts")).toBe("")
    expect(run("src/../x.ts")).toBe("")
  })

  test("untrusted stderr is wrapped so a :: line is not a workflow command", () => {
    const out = quarantine("::error::forged\n::add-mask::x")
    const [open, , , close] = out.split("\n")
    expect(open).toMatch(/^::stop-commands::[0-9a-f-]{36}$/)
    expect(close).toBe(`::${open?.slice("::stop-commands::".length)}::`)
  })
})

describe("action inputs and outputs", () => {
  test("fail-on accepts only the documented values", () => {
    expect(isFailOn("error")).toBe(true)
    expect(isFailOn("warning")).toBe(true)
    expect(isFailOn("never")).toBe(true)
    expect(isFailOn("warn")).toBe(false)
    expect(isFailOn("")).toBe(false)
  })

  test("the findings output stays bounded however many findings there are", () => {
    const diagnostics = Array.from({ length: 3000 }, (_, i) => ({
      code: `C${i}`,
      severity: "warning",
      message: "m".repeat(300),
      file: "f.ts",
      evidence: Array(10).fill("e".repeat(300)),
    }))
    const { findings } = analyze(JSON.stringify({ ok: false, diagnostics }), "1", "error")
    const json = outputFindings(findings)
    expect(Buffer.byteLength(json)).toBeLessThan(100_000)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: outputFindings emits a JSON array of Finding
    const parsed = JSON.parse(json) as Finding[]
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed.length).toBeLessThanOrEqual(100)
    expect(parsed[0]?.evidence.length).toBe(3)
  })
})
