/**
 * What a CI benchmark report records about the Linux runner it ran on: the CPU model, how the cores
 * were split between server and load generator, and how much CPU time the hypervisor stole. Hosted
 * runners change CPU model between runs, so none of this is constant, and every reader returns
 * `undefined` off Linux rather than guessing.
 */
import { existsSync, readFileSync } from "node:fs"

/** "0-3,6" -> [0, 1, 2, 3, 6], the format of sysfs and /proc CPU lists. */
export function parseCpuList(text: string): number[] {
  const trimmed = text.trim()
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(trimmed)) {
    throw new Error(`not a CPU list: "${trimmed}"`)
  }
  const cpus: number[] = []
  for (const part of trimmed.split(",")) {
    const [first, last = first] = part.split("-").map(Number)
    if (first === undefined || last === undefined || last < first) {
      throw new Error(`bad CPU range "${part}"`)
    }
    for (let cpu = first; cpu <= last; cpu++) cpus.push(cpu)
  }
  return cpus
}

export interface CoreSplit {
  /** CPUs the servers under test run on. */
  readonly server: readonly number[]
  /** CPUs oha and the harness run on. */
  readonly load: readonly number[]
  /** Physical cores the allowed CPUs sit on. */
  readonly cores: number
}

/**
 * Split the allowed CPUs by physical core, never across one: hyperthread siblings share execution
 * units, so a server on one sibling and oha on the other would still contend. The servers get the
 * first half of the cores; an odd core goes to the load side, since oha drives 50 connections on
 * every thread it has while each server is mostly one event loop.
 */
export function splitCores(
  allowed: readonly number[],
  siblingsOf: (cpu: number) => readonly number[],
): CoreSplit {
  const allowedSet = new Set(allowed)
  const byCore = new Map<number, number[]>()
  for (const cpu of [...allowed].sort((a, b) => a - b)) {
    const siblings = siblingsOf(cpu).filter((c) => allowedSet.has(c))
    const core = Math.min(cpu, ...siblings)
    const group = byCore.get(core) ?? []
    if (!group.includes(cpu)) group.push(cpu)
    byCore.set(core, group)
  }
  const cores = [...byCore.entries()].sort(([a], [b]) => a - b).map(([, cpus]) => cpus)
  if (cores.length < 2) {
    throw new Error(
      `pinning needs at least 2 physical cores; this host allows ${allowed.length} CPU(s) on ${cores.length}`,
    )
  }
  const serverCores = Math.floor(cores.length / 2)
  return {
    server: cores.slice(0, serverCores).flat(),
    load: cores.slice(serverCores).flat(),
    cores: cores.length,
  }
}

const readIfPresent = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined

/** The core split for this process's allowed CPUs, or `undefined` off Linux. */
export function readCoreSplit(): CoreSplit | undefined {
  const status = readIfPresent("/proc/self/status")
  const allowedLine = status?.split("\n").find((line) => line.startsWith("Cpus_allowed_list:"))
  if (allowedLine === undefined) return undefined
  const allowed = parseCpuList(allowedLine.slice("Cpus_allowed_list:".length))
  return splitCores(allowed, (cpu) => {
    const siblings = readIfPresent(
      `/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`,
    )
    return siblings === undefined ? [cpu] : parseCpuList(siblings)
  })
}

export interface CpuTimes {
  readonly total: number
  readonly steal: number
}

/**
 * The aggregate `cpu` line of /proc/stat: user nice system idle iowait irq softirq steal, then guest
 * and guest_nice, which the kernel already counts inside user and nice and so stay out of the total.
 */
export function parseProcStat(text: string): CpuTimes {
  const line = text.split("\n").find((l) => l.startsWith("cpu "))
  const fields = line?.trim().split(/\s+/).slice(1, 9).map(Number) ?? []
  if (fields.length < 8 || fields.some((f) => !Number.isFinite(f))) {
    throw new Error("/proc/stat has no readable aggregate cpu line")
  }
  return { total: fields.reduce((sum, f) => sum + f, 0), steal: fields[7] ?? 0 }
}

export function readCpuTimes(): CpuTimes | undefined {
  const stat = readIfPresent("/proc/stat")
  return stat === undefined ? undefined : parseProcStat(stat)
}

/** The share of CPU time the hypervisor took between two readings. */
export function stealShare(before: CpuTimes, after: CpuTimes): number | undefined {
  const total = after.total - before.total
  return total > 0 ? (after.steal - before.steal) / total : undefined
}

export function parseCpuModel(cpuinfo: string): string | undefined {
  const line = cpuinfo.split("\n").find((l) => /^model name\s*:/.test(l))
  const model = line?.slice(line.indexOf(":") + 1).trim()
  return model === undefined || model === "" ? undefined : model
}

export function readCpuModel(): string | undefined {
  const cpuinfo = readIfPresent("/proc/cpuinfo")
  return cpuinfo === undefined ? undefined : parseCpuModel(cpuinfo)
}
