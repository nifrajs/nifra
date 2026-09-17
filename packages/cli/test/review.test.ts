import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeReviewReport } from "@nifrajs/agent-review"
import {
  bindCommandArgv,
  findCommandSpec,
  renderCommandCatalogLines,
} from "../src/command-catalog.ts"
import { parseReviewInput, ReviewInputError, renderReviewReport, runReview } from "../src/review.ts"

async function reviewProject(source = ""): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nifra-review-"))
  await mkdir(join(root, "node_modules", "typescript", "bin"), { recursive: true })
  await mkdir(join(root, "out"), { recursive: true })
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "review-fixture" }))
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ files: [] }))
  // The check collector intentionally treats TypeScript as an optional project dependency. A tiny
  // executable fixture keeps these tests about review composition rather than the host compiler.
  await writeFile(join(root, "node_modules", "typescript", "bin", "tsc"), "process.exit(0)\n")
  if (source.length > 0) {
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "users.ts"), source)
  }
  return root
}

async function git(root: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" })
  const stderr = await new Response(proc.stderr).text()
  const status = await proc.exited
  if (status !== 0) throw new Error(stderr)
}

function reportKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(reportKeys)
  if (typeof value !== "object" || value === null) return []
  const record = value as Record<string, unknown>
  return [...Object.keys(record), ...Object.values(record).flatMap(reportKeys)]
}

describe("nifra review command contract", () => {
  test("shares one strict, bounded input parser with argv binding", () => {
    const spec = findCommandSpec("review")
    expect(spec).toBeDefined()
    expect(
      bindCommandArgv(spec!, [
        "--strict",
        "--diff",
        "main",
        "--sarif",
        "out/report.sarif",
        "--fix",
        "--dry-run",
        "--json",
      ]),
    ).toEqual({
      strict: true,
      diff: "main",
      sarif: "out/report.sarif",
      fix: true,
      dryRun: true,
      json: true,
    })
    expect(() => parseReviewInput({ dryRun: true })).toThrow(ReviewInputError)
    expect(() => parseReviewInput({ write: true })).toThrow(ReviewInputError)
    expect(() => parseReviewInput({ dryRun: true, write: true, fix: true })).toThrow(
      ReviewInputError,
    )
    expect(() => parseReviewInput({ unknown: true })).toThrow(ReviewInputError)
    expect(renderCommandCatalogLines().some((line) => line.startsWith("nifra review "))).toBe(true)
  })

  test("returns a completed pass with only bounded structural fields", async () => {
    const root = await reviewProject()
    try {
      const report = await runReview({}, { cwd: root })
      expect(report.status).toBe("pass")
      expect(report.ok).toBe(true)
      expect(report.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(renderReviewReport(report)[0]).toContain("review passed")
      expect(
        reportKeys(report).some((key) =>
          /message|prompt|payload|stdout|stderr|stack|secret/i.test(key),
        ),
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("maps a blocking diagnostic without forwarding its message", async () => {
    const root = await reviewProject('const result = await fetch("/users")\n')
    try {
      const report = await runReview({}, { cwd: root })
      expect(report.status).toBe("fail")
      expect(report.ok).toBe(false)
      expect(report.blocking).toBeGreaterThan(0)
      expect(report.findings.some((finding) => finding.code === "NF-C002")).toBe(true)
      expect(report.findings.every((finding) => finding.evidence.length > 0)).toBe(true)
      expect(renderReviewReport(report).join("\n")).not.toContain("hand-rolled fetch")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("invalid Git scope is inconclusive and cannot produce a SARIF artifact", async () => {
    const root = await reviewProject()
    try {
      const report = await runReview(
        { diff: "does-not-exist", sarif: "out/report.sarif" },
        { cwd: root },
      )
      expect(report.status).toBe("inconclusive")
      expect(report.scope.state).toBe("invalid")
      expect(report.scope.reasonCode).toBe("invalid-git-ref")
      expect(report.blocking).toBe(0)
      await expect(readFile(join(root, "out", "report.sarif"))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("filters unchanged file findings for a valid Git diff while retaining scope evidence", async () => {
    const root = await reviewProject('const result = await fetch("/unchanged")\n')
    try {
      await git(root, ["init", "-q"])
      await git(root, ["config", "user.email", "test@example.invalid"])
      await git(root, ["config", "user.name", "Nifra Test"])
      await git(root, ["add", "."])
      await git(root, ["commit", "-qm", "baseline"])
      await writeFile(join(root, "README.md"), "changed\n")
      const baseline = await new Response(
        Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" })
          .stdout,
      ).text()
      const report = await runReview({ diff: baseline.trim() }, { cwd: root })
      expect(report.scope.state).toBe("valid")
      expect(report.scope.changedPaths).toContain("README.md")
      expect(report.scope.outOfScopeCount).toBeGreaterThan(0)
      expect(report.findings.some((finding) => finding.location?.path === "src/users.ts")).toBe(
        false,
      )
      expect(
        report.checks.find((check) => check.id === "typed-client")?.counts.outOfScope,
      ).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("writes SARIF only for a completed review and uses static messages", async () => {
    const root = await reviewProject('const result = await fetch("/users")\n')
    try {
      const report = await runReview(
        { sarif: "out/report.sarif" },
        { cwd: root, cliVersion: "3.4.0" },
      )
      expect(report.status).toBe("fail")
      const sarif = JSON.parse(await readFile(join(root, "out", "report.sarif"), "utf8")) as {
        runs: Array<{
          tool: { driver: { version?: string } }
          results: Array<{ message: { text: string } }>
        }>
      }
      expect(sarif.runs[0]?.tool.driver.version).toBe("3.4.0")
      expect(
        sarif.runs[0]?.results.some((result) => result.message.text === "Typed client check"),
      ).toBe(true)
      expect(JSON.stringify(sarif)).not.toContain("hand-rolled fetch")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("maps a malformed SARIF path to the review input exit code", async () => {
    const root = await reviewProject()
    try {
      await expect(runReview({ sarif: "../outside.sarif" }, { cwd: root })).rejects.toMatchObject({
        exitCode: 2,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("exit code projection distinguishes pass, fail, and inconclusive", async () => {
    const spec = findCommandSpec("review")!
    const pass = await composeReviewReport({
      strict: false,
      scope: {
        kind: "project",
        state: "valid",
        changedPaths: [],
        pathDigest: "a".repeat(64),
        outOfScopeCount: 0,
      },
      checks: [],
      findings: [],
    })
    const fail = await composeReviewReport({
      strict: false,
      scope: {
        kind: "project",
        state: "valid",
        changedPaths: [],
        pathDigest: "a".repeat(64),
        outOfScopeCount: 0,
      },
      checks: [
        {
          id: "security",
          required: true,
          status: "fail",
          duration: "fast",
          counts: { findings: 1, errors: 1, warnings: 0, info: 0, outOfScope: 0 },
          findingIds: ["f"],
          evidence: [{ source: "check", token: "e", digest: "b".repeat(64) }],
        },
      ],
      findings: [
        {
          id: "f",
          check: "security",
          code: "NF-S001",
          severity: "error",
          category: "security",
          evidence: [{ source: "check", token: "e", digest: "b".repeat(64) }],
        },
      ],
    })
    const inconclusive = await composeReviewReport({
      strict: false,
      scope: {
        kind: "project",
        state: "invalid",
        changedPaths: [],
        pathDigest: "0".repeat(64),
        outOfScopeCount: 0,
        reasonCode: "invalid-git-scope",
      },
      checks: [
        {
          id: "configuration",
          required: true,
          status: "error",
          duration: "none",
          counts: { findings: 0, errors: 0, warnings: 0, info: 0, outOfScope: 0 },
          findingIds: [],
          evidence: [{ source: "collector", token: "e", digest: "b".repeat(64) }],
          reasonCode: "collector-error",
        },
      ],
      findings: [],
    })
    expect(spec.exitCode?.(pass, {})).toBe(0)
    expect(spec.exitCode?.(fail, {})).toBe(1)
    expect(spec.exitCode?.(inconclusive, {})).toBe(2)
  })
})
