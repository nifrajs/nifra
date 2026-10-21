/**
 * The Redis commands the live bus sends, kept in memory: `EVAL` runs the append script's steps in JS,
 * and a blocking `XREAD` waits for an append instead of a timer.
 */
import { APPEND_SCRIPT, type RedisCommand } from "../src/live-redis.ts"

interface Entry {
  readonly id: string
  readonly fields: readonly string[]
}

/** Stream ids order by their time part, then their sequence part. */
function idAfter(id: string, cursor: string): boolean {
  const [time = 0, part = 0] = id.split("-").map(Number)
  const [afterTime = 0, afterPart = 0] = cursor.split("-").map(Number)
  return time > afterTime || (time === afterTime && part > afterPart)
}

export function memoryRedis() {
  const streams = new Map<string, Entry[]>()
  const hashes = new Map<string, Map<string, string>>()
  const wake: (() => void)[] = []
  const failures = { read: 0 }
  const reads = { pending: 0 }
  const hash = (name: string): Map<string, string> => {
    let h = hashes.get(name)
    if (h === undefined) {
      h = new Map()
      hashes.set(name, h)
    }
    return h
  }
  const stream = (name: string): Entry[] => {
    let s = streams.get(name)
    if (s === undefined) {
      s = []
      streams.set(name, s)
    }
    return s
  }
  const add = (key: string, entry: Entry, max = Number.POSITIVE_INFINITY): void => {
    const s = stream(key)
    const top = s.at(-1)
    if (top !== undefined && !idAfter(entry.id, top.id))
      throw new Error(
        "ERR The ID specified in XADD is equal or smaller than the target stream top item",
      )
    s.push(entry)
    while (s.length > max) s.shift()
    for (const resolve of wake.splice(0)) resolve()
  }
  const send: RedisCommand = async (command, args) => {
    if (command === "HMGET") {
      const h = hashes.get(args[0] ?? "")
      return args.slice(1).map((field) => h?.get(field) ?? null)
    }
    if (command === "EVAL") {
      if (args[0] !== APPEND_SCRIPT) throw new Error("unknown script")
      const [, , key = "", clock = "", body = "", max = "0"] = args
      const h = hash(clock)
      const seq = Math.max(Number(h.get("seq") ?? 0) + 1, Date.now() * 1000)
      const n = Number(h.get("n") ?? 0) + 1
      add(key, { id: `${seq}-0`, fields: ["n", String(n), "e", body] }, Number(max))
      h.set("n", String(n))
      h.set("seq", String(seq))
      return String(seq)
    }
    throw new Error(`unexpected ${command}`)
  }
  // Blocks until an append wakes it, never on a timer; a failure is taken after the wait, so a test
  // arms one while a read is parked and the next append trips it.
  const read: RedisCommand = async (command, args) => {
    if (command !== "XREAD") throw new Error(`unexpected ${command}`)
    reads.pending++
    try {
      const key = args[5] ?? ""
      const cursor = args[6] ?? "0-0"
      const ready = (): Entry[] => stream(key).filter((entry) => idAfter(entry.id, cursor))
      if (ready().length === 0) await new Promise<void>((resolve) => wake.push(resolve))
      if (failures.read > 0) {
        failures.read--
        throw new Error("connection reset")
      }
      return [[key, ready().map((entry) => [entry.id, [...entry.fields]])]]
    } finally {
      reads.pending--
    }
  }
  /** Adds an entry the bus did not append, as another writer would. */
  const push = (key: string, id: string, fields: readonly string[]): void =>
    add(key, { id, fields })
  return { send, read, failures, reads, streams, push }
}
