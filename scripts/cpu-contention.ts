/**
 * Runs a command beside threads that spin for as long as it runs, so a test that only holds on an
 * idle machine (a short deadline, a tight elapsed bound, a sleep standing in for a ready signal) fails
 * on a schedule instead of on a release day.
 *
 *   bun scripts/cpu-contention.ts [--per-core <n>] [--threads <n>] -- <command> [args...]
 *
 * The spinners are worker threads of this process, so they end with it however it exits.
 */
import { availableParallelism } from "node:os"
import { isMainThread, Worker } from "node:worker_threads"

const DEFAULT_PER_CORE = 2

export interface ContentionArgs {
  readonly threads: number
  readonly command: readonly string[]
}

export function parseContentionArgs(argv: readonly string[], cores: number): ContentionArgs {
  let threads = cores * DEFAULT_PER_CORE
  let index = 0
  for (; index < argv.length && argv[index]!.startsWith("--") && argv[index] !== "--"; index += 2) {
    const flag = argv[index]
    const value = Number(argv[index + 1])
    if (flag !== "--per-core" && flag !== "--threads") throw new Error(`unknown option ${flag}`)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${flag} takes a positive integer, saw ${argv[index + 1]}`)
    threads = flag === "--per-core" ? cores * value : value
  }
  // Bun drops a `--` that directly follows the script path, so the separator is optional.
  if (argv[index] === "--") index++
  const command = argv.slice(index)
  if (command.length === 0)
    throw new Error("usage: cpu-contention.ts [--per-core <n>] [--threads <n>] [--] <command>")
  return { threads, command }
}

if (!isMainThread) {
  for (;;) {}
}

if (isMainThread && import.meta.main) {
  const { threads, command } = parseContentionArgs(process.argv.slice(2), availableParallelism())
  const spinners = Array.from({ length: threads }, () => new Worker(import.meta.path))
  console.log(`cpu-contention: ${threads} spinning threads beside \`${command.join(" ")}\``)
  const child = Bun.spawn([...command], { stdio: ["inherit", "inherit", "inherit"] })
  const code = await child.exited
  for (const spinner of spinners) void spinner.terminate()
  process.exit(code)
}
