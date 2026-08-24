/**
 * Run the complete Bun test surface in bounded child processes on Windows.
 *
 * Bun 1.3.x on Windows can panic with `integer overflow` after the monorepo's single, multi-directory
 * test invocation grows to roughly a gigabyte of resident memory. Splitting by package keeps the
 * process graph bounded; it does not weaken the gate because every child goes through the same strict
 * tolerant-test wrapper, which rejects assertion failures, crashes, and runs without a summary.
 */
import { spawn } from "node:child_process"
import { join, resolve } from "node:path"
import { Glob } from "bun"

const ROOT = resolve(import.meta.dir, "..")

const groups: ReadonlyArray<readonly string[]> = [
  [
    "packages/core/test",
    "packages/client/test",
    "packages/schema/test",
    "packages/env/test",
    "packages/cron/test",
    "packages/events/test",
    "packages/otel/test",
    "packages/agent-telemetry/test",
    "packages/agent/test",
    "packages/agent-app/test",
    "packages/agent-protocol/test",
    "packages/pi/test",
  ],
  [
    "packages/devtools/test",
    "packages/mock/test",
    "packages/prompt/test",
    "packages/middleware/test",
    "packages/auth/test",
    "packages/better-auth/test",
    "packages/i18n/test",
    "packages/proxy/test",
    "packages/aws-lambda/test",
    "packages/edge/test",
    "packages/graphql/test",
    "packages/a2a/test",
    "packages/ag-ui/test",
    "packages/image/test",
    "packages/uploads/test",
  ],
  [
    "packages/node/test",
    "packages/workers/test",
    "packages/content/test",
    "packages/runner/test",
    "packages/web/test",
    "packages/web-solid/test",
    "packages/web-react/test",
    "packages/web-vue/test",
    "packages/web-preact/test",
    "packages/web-vanilla/test",
    "packages/islets/test",
    "packages/island-trigger/test",
    "packages/web-svelte/test",
    "packages/storage/test",
    "packages/jobs/test",
    "packages/cache/test",
    "packages/testing/test",
    "packages/create-nifra/test",
    "packages/ts-plugin/test",
    "packages/cli/test",
  ],
]

async function testFilesIn(directories: readonly string[]): Promise<string[]> {
  const files = await Promise.all(
    directories.map(async (directory) => {
      const root = resolve(ROOT, directory)
      const matches = await Array.fromAsync(new Glob("**/*.test.{ts,tsx}").scan({ cwd: root }))
      return matches.sort().map((file) => join(directory, file))
    }),
  )
  return files.flat()
}

async function runBatch(
  label: string,
  directories: readonly string[],
  testArgs: readonly string[] = [],
): Promise<number> {
  const files = await testFilesIn(directories)
  if (files.length === 0) {
    console.error(`[windows-tests] ${label} resolved no test files`)
    return 1
  }
  console.log(`\n==> Windows Bun test ${label} (${files.length} files)`)
  const child = spawn(
    process.execPath,
    ["run", "scripts/tolerant-test.ts", ...files, ...testArgs],
    {
      stdio: "inherit",
      cwd: ROOT,
    },
  )
  return await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1))
    child.once("close", (code) => resolve(code ?? 1))
  })
}

const batches: ReadonlyArray<readonly [string, readonly string[]]> = [
  ...groups.map((directories, index) => [`${index + 1}/4`, directories] as const),
  ["4/4", ["packages/mcp/test", "packages/mcp-db/test", "scripts"]],
]

// The isolated extension test launches a second Bun process and is sensitive to Windows runner
// contention. Keep it covered, but run the package serially with a diagnostic-only timeout budget.
const codingAgentStatus = await runBatch(
  "coding-agent (dedicated; serial, 30s timeout)",
  ["packages/coding-agent/test"],
  ["--max-concurrency", "1", "--timeout", "30000"],
)
if (codingAgentStatus !== 0) process.exit(codingAgentStatus)

for (const [label, directories] of batches) {
  const status = await runBatch(label, directories)
  if (status !== 0) process.exit(status)
}
