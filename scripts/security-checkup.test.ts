import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const SKILL = join(import.meta.dir, "..", ".claude", "skills", "security-checkup")
const PROBES = join(SKILL, "scripts", "probes.ts")

const scratch: string[] = []
afterAll(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))))

// A fake scanner on PATH: it answers the version probe at the pin, logs the scan's argv, writes `[]`
// to any --report-path it is given, prints FAKE_STDOUT, and exits FAKE_EXIT.
const FAKE = `#!/bin/sh
case "$1" in
  version|--version) echo "$FAKE_VERSION"; exit 0 ;;
esac
printf '%s\\n' "$@" > "$FAKE_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = "--report-path" ] && [ "$FAKE_EXIT" -le 1 ]; then echo '[]' > "$2"; fi
  shift
done
printf '%s' "$FAKE_STDOUT"
exit "$FAKE_EXIT"
`

const PINS = { "osv-scanner": "2.4.0", gitleaks: "8.30.1", semgrep: "1.99.0" } as const
type Tool = keyof typeof PINS
const PROBE_OF = { "osv-scanner": "depsProbe", gitleaks: "secretsProbe", semgrep: "patternsProbe" }

// Bun.spawn children keep the startup environment, so each probe runs in a child given its own PATH.
async function runProbe(tool: Tool, exit: number, stdout = "") {
  const root = await mkdtemp(join(tmpdir(), "security-checkup-"))
  scratch.push(root)
  const bin = join(root, ".bin")
  await mkdir(bin)
  await writeFile(join(bin, tool), FAKE)
  await chmod(join(bin, tool), 0o755)
  await writeFile(join(root, "bun.lock"), "{}")
  const log = join(root, ".argv")
  const script = `
    const probes = await import(${JSON.stringify(PROBES)})
    const ctx = { repoRoot: ${JSON.stringify(root)}, fast: false, strictTools: false, semgrepRules: "rules.yml" }
    try {
      const result = await probes[${JSON.stringify(PROBE_OF[tool])}](ctx)
      console.log(JSON.stringify({ findings: result.findings.length, degraded: result.degraded ?? null }))
    } catch (error) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }`
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_VERSION: PINS[tool],
      FAKE_EXIT: String(exit),
      FAKE_STDOUT: stdout,
      FAKE_LOG: log,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [text] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const argv = await readFile(log, "utf8").then(
    (body) => body.split("\n").filter(Boolean),
    (): string[] => [],
  )
  return { result: JSON.parse(text.trim().split("\n").at(-1) ?? "{}"), argv }
}

test.skipIf(process.platform === "win32")(
  "a scanner that fails is an error, never a clean scan",
  async () => {
    for (const tool of ["osv-scanner", "gitleaks", "semgrep"] as const) {
      const { result } = await runProbe(tool, 2)
      expect({ tool, failed: typeof result.error === "string" }).toEqual({ tool, failed: true })
    }
  },
)

test.skipIf(process.platform === "win32")(
  "gitleaks runs with --redact and its report is removed before the probe returns",
  async () => {
    const { result, argv } = await runProbe("gitleaks", 0)
    expect(result).toEqual({ findings: 0, degraded: null })
    expect(argv).toContain("--redact")
    expect(argv).toContain("--report-path")
    const reportPath = argv[argv.indexOf("--report-path") + 1] ?? ""
    const kept = await stat(dirname(reportPath)).then(
      () => true,
      () => false,
    )
    expect(kept).toBe(false)
  },
)

test("every semgrep rule parses, and every pattern in it is a string", async () => {
  const parsed: unknown = Bun.YAML.parse(
    await readFile(join(SKILL, "rules", "semgrep.yml"), "utf8"),
  )
  const rules =
    typeof parsed === "object" &&
    parsed !== null &&
    "rules" in parsed &&
    Array.isArray(parsed.rules)
      ? parsed.rules
      : []
  const offending: string[] = []
  const walk = (id: string, node: unknown): void => {
    if (Array.isArray(node)) for (const item of node) walk(id, item)
    else if (node !== null && typeof node === "object")
      for (const [key, value] of Object.entries(node)) {
        if (/^pattern(-not|-inside|-not-inside|-regex)?$/.test(key) && typeof value !== "string")
          offending.push(`${id}: ${key}`)
        walk(id, value)
      }
  }
  for (const rule of rules) walk(String(rule.id), rule)
  expect(rules.length).toBeGreaterThan(0)
  expect(offending).toEqual([])
})
