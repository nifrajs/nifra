/**
 * A live bus on Redis Streams, for an app that several processes serve. Every append runs one Lua
 * script: a hybrid logical clock in microseconds (never below the server's clock, always above the
 * last seq), then `XADD` with that seq as the entry id, trimmed to about `maxLength` entries. Each
 * process reads the stream from its last id with a blocking `XREAD` on a connection of its own.
 *
 *   import { RedisClient } from "bun"
 *   import { redisLiveBus } from "@nifrajs/web/live-redis"
 *
 *   const shared = new RedisClient(process.env.REDIS_URL)
 *   const reader = new RedisClient(process.env.REDIS_URL)
 *   const bus = redisLiveBus({
 *     send: (command, args) => shared.send(command, [...args]),
 *     read: (command, args) => reader.send(command, [...args]),
 *   })
 *   const runtime = live({ secret, subject, bus, instances: 4 })
 *
 * Every entry also carries a running count, so a reader that fell behind a trim - or lost the
 * connection - reports the gap instead of skipping what it missed.
 */
import type { LiveBus, LiveBusEvent, LiveBusListener } from "./live/bus.ts"

/** Send one Redis command and resolve with its reply, as any client's raw-command call does. */
export type RedisCommand = (command: string, args: readonly string[]) => Promise<unknown>

export interface RedisLiveBusOptions {
  /** Appends and reads the clock; any connection. */
  readonly send: RedisCommand
  /** Reads the stream. Its own connection: a blocking `XREAD` holds it. */
  readonly read: RedisCommand
  /** The stream; the clock lives at `<key>:clock`. Default `nifra:live`. */
  readonly key?: string
  /** Entries kept, roughly. Default 100,000, the most the live history keeps. */
  readonly maxLength?: number
  /** How long one `XREAD` blocks, in ms. Default 5,000. */
  readonly blockMs?: number
}

/**
 * KEYS[1] the stream, KEYS[2] the clock hash; ARGV[1] the event JSON, ARGV[2] the trim length.
 * Lua numbers are doubles: a microsecond clock stays exact below 2^53 (the year 2255).
 */
export const APPEND_SCRIPT = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000000 + tonumber(t[2])
local last = tonumber(redis.call('HGET', KEYS[2], 'seq') or '0')
local seq = math.max(last + 1, now)
local id = string.format('%.0f', seq)
local n = redis.call('HINCRBY', KEYS[2], 'n', 1)
redis.call('HSET', KEYS[2], 'seq', id)
redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], id .. '-0', 'n', n, 'e', ARGV[1])
return id`

const RETRY_MS = [100, 500, 1_000, 2_000, 5_000]

export function redisLiveBus(options: RedisLiveBusOptions): LiveBus {
  const key = options.key ?? "nifra:live"
  const clock = `${key}:clock`
  const maxLength = String(options.maxLength ?? 100_000)
  const blockMs = String(options.blockMs ?? 5_000)

  /** The clock's seq and running count, as the last append left them. */
  const position = async (): Promise<{ seq: number; n: number }> => {
    const reply = await options.send("HMGET", [clock, "seq", "n"])
    const [seq, n] = Array.isArray(reply) ? reply : []
    return { seq: countOf(seq), n: countOf(n) }
  }

  return {
    async append(input) {
      const reply = await options.send("EVAL", [
        APPEND_SCRIPT,
        "2",
        key,
        clock,
        JSON.stringify(input),
        maxLength,
      ])
      const seq = countOf(reply)
      if (seq === 0) throw new Error("[nifra/web] live-redis: the append script returned no seq")
      return seq
    },

    async subscribe(listener) {
      const start = await position()
      let closed = false
      void follow(start.seq, start.n, listener, () => closed)
      return {
        head: start.seq,
        close: () => {
          closed = true
        },
      }
    },
  }

  async function follow(
    head: number,
    count: number,
    listener: LiveBusListener,
    isClosed: () => boolean,
  ): Promise<void> {
    let last = head
    // The id the next read starts after, verbatim: an id this bus did not write still moves it on.
    let cursor = `${head}-0`
    let expected = count + 1
    let failures = 0
    while (!isClosed()) {
      let entries: Entry[] | undefined
      try {
        const reply = await options.read("XREAD", [
          "BLOCK",
          blockMs,
          "COUNT",
          "1000",
          "STREAMS",
          key,
          cursor,
        ])
        entries = reply === null || reply === undefined ? [] : entriesOf(reply)
      } catch {
        entries = undefined
      }
      if (entries === undefined) {
        // A reply of no known shape counts as a failed read, so it backs off instead of spinning.
        failures++
        // One failed read may be a hiccup; a second in a row is an outage.
        if (failures === 2) listener.down()
        await wait(RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)] ?? 5_000)
        if (failures < 2 || isClosed()) continue
        try {
          const now = await position()
          if (isClosed()) return
          // Whatever happened while the bus was unreachable is unknown: resume after the clock.
          listener.gap(now.seq)
          last = now.seq
          cursor = `${now.seq}-0`
          expected = now.n + 1
          failures = 0
        } catch {
          // Still down; the next read tries again.
        }
        continue
      }
      failures = 0
      for (const entry of entries) {
        if (isClosed()) return
        cursor = entry.id
        if (entry.seq === 0) {
          listener.gap(last)
          continue
        }
        if (entry.n !== expected) {
          // Entries between were trimmed before this reader got to them.
          listener.gap(entry.seq - 1)
        }
        expected = entry.n + 1
        last = entry.seq
        if (entry.event === undefined) listener.gap(entry.seq)
        else listener.event(entry.event)
      }
    }
  }
}

interface Entry {
  readonly id: string
  /** 0 when the id is not one this bus writes. */
  readonly seq: number
  readonly n: number
  /** Undefined when the entry does not hold a bus event. */
  readonly event: LiveBusEvent | undefined
}

/**
 * The entries of an `XREAD` reply for one stream - RESP2 `[[key, entries]]`, RESP3 `{ key: entries }`
 * or a `Map` - each entry `[id, [field, value, ...]]`. Undefined when the reply has none of these shapes.
 */
function entriesOf(reply: unknown): Entry[] | undefined {
  let streams: unknown[]
  if (Array.isArray(reply))
    streams = reply.map((stream) => (Array.isArray(stream) ? stream[1] : undefined))
  else if (reply instanceof Map) streams = [...reply.values()]
  else if (isRecord(reply)) streams = Object.values(reply)
  else return undefined
  const out: Entry[] = []
  for (const entries of streams) {
    if (!Array.isArray(entries)) return undefined
    for (const entry of entries) {
      if (!Array.isArray(entry)) return undefined
      const [id, fields]: unknown[] = entry
      if (typeof id !== "string" || !Array.isArray(fields)) return undefined
      const [time, part] = id.split("-")
      const seq = part === "0" ? countOf(time) : 0
      let n = 0
      let body: unknown
      for (let i = 0; i + 1 < fields.length; i += 2) {
        if (fields[i] === "n") n = countOf(fields[i + 1])
        else if (fields[i] === "e") body = fields[i + 1]
      }
      out.push({ id, seq, n, event: seq === 0 ? undefined : eventOf(body, seq) })
    }
  }
  return out
}

function eventOf(body: unknown, seq: number): LiveBusEvent | undefined {
  if (typeof body !== "string") return undefined
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.type === "change" && Array.isArray(value.keys)) {
    const keys = value.keys.filter((name): name is string => typeof name === "string")
    return { type: "change", keys, seq }
  }
  const { sub, key } = value
  if (
    value.type === "revoke" &&
    (sub === null || typeof sub === "string") &&
    (key === null || typeof key === "string")
  ) {
    return { type: "revoke", sub, key, seq }
  }
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A Redis integer reply or numeric string as a non-negative safe integer, else 0. */
function countOf(value: unknown): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
