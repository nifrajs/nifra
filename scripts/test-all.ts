/**
 * Run every repo validation command with inherited stdout/stderr so local failures show their full
 * output in order.
 *
 *   bun run test:all
 */

interface Step {
  readonly name: string
  readonly cmd: readonly string[]
}

const STEPS: readonly Step[] = [
  { name: "lint", cmd: ["bun", "run", "lint"] },
  { name: "typecheck", cmd: ["bun", "run", "typecheck"] },
  { name: "bun tests", cmd: ["bun", "run", "test"] },
  { name: "deno tests", cmd: ["bun", "run", "test:deno"] },
]

for (const step of STEPS) {
  const started = performance.now()
  console.log(`\n==> ${step.name}`)
  console.log(`$ ${step.cmd.join(" ")}`)
  const proc = Bun.spawn([...step.cmd], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  const code = await proc.exited
  const elapsed = ((performance.now() - started) / 1000).toFixed(1)
  if (code !== 0) {
    console.error(`\nFAIL ${step.name} after ${elapsed}s (exit ${code})`)
    process.exit(code)
  }
  console.log(`PASS ${step.name} in ${elapsed}s`)
}

console.log("\nAll tests/checks passed.")
