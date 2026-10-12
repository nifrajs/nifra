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
  const split = argv.indexOf("--")
  if (split === -1 || split === argv.length - 1)
    throw new Error("usage: cpu-contention.ts [--per-core <n>] [--threads <n>] -- <command>")
  let threads = cores * DEFAULT_PER_CORE
  const options = argv.slice(0, split)
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index]
    const value = Number(options[index + 1])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${flag} takes a positive integer, saw ${options[index + 1]}`)
    if (flag === "--per-core") threads = cores * value
    else if (flag === "--threads") threads = value
    else throw new Error(`unknown option ${flag}`)
  }
  return { threads, command: argv.slice(split + 1) }
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
