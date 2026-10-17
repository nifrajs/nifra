/**
 * CPU pinning for the HTTP matrices. `BENCH_SERVER_CPUS` and `BENCH_LOAD_CPUS` take taskset lists
 * ("0,1", "2-3") and keep the server under test and the oha load generator on disjoint cores, so the
 * two stop trading one scheduler's time slices. Linux only; unset leaves every process unpinned.
 */

const CPU_LIST = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/

export function cpuListFromEnv(name: string): string | undefined {
  const value = Bun.env[name]
  if (value === undefined || value === "") return undefined
  if (!CPU_LIST.test(value)) {
    throw new Error(`${name}="${value}" is not a CPU list such as "0,1" or "2-3"`)
  }
  return value
}

/** `argv` under `taskset -c cpus`, or unchanged when `cpus` is undefined. A missing taskset fails the spawn. */
export function pinned(argv: readonly string[], cpus: string | undefined): string[] {
  return cpus === undefined ? [...argv] : ["taskset", "-c", cpus, ...argv]
}
