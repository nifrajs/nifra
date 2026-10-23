/** What the PPR benches share: their child processes and the CPU and statistics they read. */
import { join } from "node:path"

export interface Listening {
  readonly proc: Bun.Subprocess<"ignore", "pipe", "inherit">
  readonly origin: string
}

/** Spawn this directory's `script` in production, once it prints `on <origin>`. */
export async function spawnUntilListening(
  script: string,
  env: Record<string, string>,
): Promise<Listening> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, script)], {
    env: { ...process.env, NODE_ENV: "production", ...env },
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = proc.stdout.getReader()
  let out = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`${script} exited before listening: ${out}`)
    out += new TextDecoder().decode(value)
    const origin = /on (http:\/\/\S+)/.exec(out)?.[1]
    if (origin !== undefined) {
      reader.releaseLock()
      return { proc, origin: origin.replace(/\/$/, "") }
    }
  }
}

/** The server process's CPU time so far, in microseconds, from the bench server's `/__cpu`. */
export const cpuOf = async (origin: string): Promise<number> => {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the bench server's own /__cpu route returns process.cpuUsage().
  const usage = (await (await fetch(`${origin}/__cpu`)).json()) as { user: number; system: number }
  return usage.user + usage.system
}

/** The process's CPU per millisecond while it serves nothing. */
export async function idleCpuPerMs(origin: string): Promise<number> {
  const before = await cpuOf(origin)
  const started = performance.now()
  await Bun.sleep(3_000)
  return ((await cpuOf(origin)) - before) / (performance.now() - started)
}

export const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN

export const percentile = (values: readonly number[], p: number): number =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ??
  Number.NaN

export const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length

export const freshId = (): string => `u${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
