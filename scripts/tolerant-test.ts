/**
 * `bun run test` runs a library test suite through this wrapper so the run tolerates ONLY the documented
 * Bun shutdown-rejection exit-1 quirk - nothing else.
 *
 * Bun mis-flags a concurrently-consumed, HANDLED promise rejection as "unhandled" at process shutdown, so
 * `bun test` can exit non-zero even when every test passed. It was diagnosed to a Bun runtime bug, not a
 * code defect (see packages/web/test/deferred.test.ts); the only in-code "fix" is to sequentialize the
 * deferred stream, which regresses the out-of-order streaming that test proves, so it is deliberately not
 * done. A genuinely red suite must still block a release, so this treats a non-zero exit as a pass ONLY
 * when a COMPLETED run reported zero test failures: a real failure always prints a `(fail)` line and a
 * non-zero fail count, both surfaced unchanged, and a run that never reached its summary (a bad path or
 * flag that executed no tests) is failed rather than mistaken for the quirk. It errs toward FAILING on
 * any ambiguity.
 *
 * Coverage is NOT requested here: it is opt-in via `--coverage` and graded by the separate
 * `test:coverage` + `check:coverage` step. That separation is load-bearing, not tidiness - a coverage
 * threshold miss prints `0 fail` with no `(fail)` line, so it is indistinguishable from the shutdown
 * quirk and this wrapper would mask it. Keeping coverage out of this run leaves exactly one signal
 * here: test pass/fail.
 */
import { spawn } from "node:child_process"

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error(
    "[tolerant-test] usage: bun run scripts/tolerant-test.ts <test-dir> [<test-dir> ...]",
  )
  process.exit(2)
}

let captured = ""
const child = spawn(process.execPath, ["test", ...dirs], {
  stdio: ["inherit", "pipe", "pipe"],
})
// Stream live so CI logs are unchanged, while capturing to classify the exit afterward.
child.stdout?.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk)
  captured += chunk
})
child.stderr?.on("data", (chunk: Buffer) => {
  process.stderr.write(chunk)
  captured += chunk
})

const status: number = await new Promise((resolve) => {
  child.on("close", (code) => resolve(code ?? 1))
  child.on("error", () => resolve(1))
})

if (status === 0) process.exit(0)

// The shutdown-rejection quirk fires only AFTER a full run completes, so a non-zero exit with no
// completed-run summary is never the quirk - it is a run that executed no tests (a bad flag or path).
// Fail it loudly rather than mask a zero-tests run as a pass: an invalid `--coverage=false` once made
// `bun test` print usage and exit non-zero having run nothing, and this wrapper reported green.
const completedRun = /\bRan \d+ tests? across \d+ files?/.test(captured)
if (!completedRun) {
  console.error(
    `[tolerant-test] bun exited ${status} without completing a test run (no summary) - failing, not ` +
      "treating as the shutdown quirk.",
  )
  process.exit(status || 1)
}

// Non-zero exit: distinguish a REAL failure from the shutdown-rejection quirk. Either signal means a real
// failure, and both err toward failing (a stray match fails the suite rather than masking a problem).
const hasFailLine = /\(fail\)/.test(captured)
const nonZeroFailCount = /^\s*[1-9]\d* fail\b/m.test(captured)
if (hasFailLine || nonZeroFailCount) {
  console.error(`[tolerant-test] real test failures present; exiting ${status}.`)
  process.exit(status)
}

console.error(
  `[tolerant-test] bun exited ${status} with zero test failures - the known Bun shutdown-rejection ` +
    "quirk (see packages/web/test/deferred.test.ts). Treating as pass.",
)
process.exit(0)
