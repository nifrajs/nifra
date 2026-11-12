import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type PerformedDecision, parseActDecision, type Target } from "./decision.ts"
import { isRecord } from "./internal/record.ts"
import { keyParams, type Params } from "./params.ts"

/**
 * `read-write` replays and records; `read-only` replays and hands off but never writes or deletes (CI);
 * `strict` replays only, and a missing or stale recording fails; `off` ignores the cache.
 */
export type CacheMode = "read-write" | "read-only" | "strict" | "off"

/** One action as it was taken. A fill's value and a goto's path keep their `{name}` placeholders. */
export type RecordedAction =
  | { readonly kind: "tap"; readonly target: Target; readonly matches: number }
  | {
      readonly kind: "fill"
      readonly target: Target
      readonly matches: number
      readonly value: string
    }
  | {
      readonly kind: "press"
      readonly target: Target
      readonly matches: number
      readonly key: string
    }
  | { readonly kind: "goto"; readonly path: string }

export interface CacheEntry {
  readonly version: 1
  readonly instruction: string
  readonly startRoute: string
  readonly actions: readonly RecordedAction[]
  readonly end: {
    readonly route: string
    readonly appeared: readonly string[]
    readonly disappeared: readonly string[]
  }
}

export interface CacheStore {
  read(key: string): Promise<CacheEntry | undefined>
  write(key: string, entry: CacheEntry): Promise<void>
  delete(key: string): Promise<void>
}

function parseAction(raw: unknown): RecordedAction | undefined {
  const parsed = parseActDecision(raw)
  if (!parsed.ok || !isRecord(raw)) return undefined
  const decision = parsed.value
  if (decision.kind === "goto") return decision
  if (decision.kind === "done" || decision.kind === "fail") return undefined
  const { matches } = raw
  if (typeof matches !== "number" || !Number.isInteger(matches) || matches < 1) return undefined
  return { ...decision, matches }
}

function strings(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw : undefined
}

/** A stored value read back as an entry, or `undefined` when it is not one (a corrupt file is a miss). */
export function parseEntry(raw: unknown): CacheEntry | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.end)) return undefined
  const { instruction, startRoute } = raw
  const { route } = raw.end
  const appeared = strings(raw.end.appeared)
  const disappeared = strings(raw.end.disappeared)
  if (typeof instruction !== "string" || typeof startRoute !== "string") return undefined
  if (typeof route !== "string" || appeared === undefined || disappeared === undefined) {
    return undefined
  }
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) return undefined
  const actions: RecordedAction[] = []
  for (const item of raw.actions) {
    const action = parseAction(item)
    if (action === undefined) return undefined
    actions.push(action)
  }
  return { version: 1, instruction, startRoute, actions, end: { route, appeared, disappeared } }
}

/** What a recorded action asked the page to do, without the bookkeeping. */
export function performedOf(action: RecordedAction): PerformedDecision {
  if (action.kind === "goto") return action
  if (action.kind === "tap") return { kind: "tap", target: action.target }
  if (action.kind === "fill") return { kind: "fill", target: action.target, value: action.value }
  return { kind: "press", target: action.target, key: action.key }
}

/** Entries as files under `dir`, one JSON per key: small, diffable and meant to be committed. */
export function fileCacheStore(dir: string): CacheStore {
  const file = (key: string): string => join(dir, `${key}.json`)
  return {
    async read(key) {
      try {
        return parseEntry(JSON.parse(await readFile(file(key), "utf8")))
      } catch {
        return undefined
      }
    },
    async write(key, entry) {
      await mkdir(dir, { recursive: true })
      const temp = `${file(key)}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`)
      await rename(temp, file(key))
    },
    async delete(key) {
      await rm(file(key), { force: true })
    },
  }
}

/** Entries in memory, for tests of code built on this package. */
export function memoryCacheStore(): CacheStore & { readonly entries: Map<string, CacheEntry> } {
  const entries = new Map<string, CacheEntry>()
  return {
    entries,
    read: async (key) => entries.get(key),
    write: async (key, entry) => {
      entries.set(key, entry)
    },
    delete: async (key) => {
      entries.delete(key)
    },
  }
}

export interface CacheOptions {
  readonly mode?: CacheMode
  /** Where entries live. Default `.nifra/e2e-cache` under the working directory. */
  readonly dir?: string
  /** Replaces the file store. */
  readonly store?: CacheStore
  /** Names the test, so two tests that say the same thing do not share a recording. Pass it: the default is empty. */
  readonly testId?: string
  /** Anything that should invalidate every recording when it changes, such as the app's version. */
  readonly appIdentity?: string
}

export interface Cache {
  readonly mode: CacheMode
  /** Whether this run may write and delete entries. */
  readonly canWrite: boolean
  /** The key for the next `act` with this instruction; asking again counts as another occurrence. */
  key(instruction: string, params: Params, context: string | undefined): string
  read(key: string): Promise<CacheEntry | undefined>
  /** Holds a new recording until a later check passes. */
  stage(key: string, entry: CacheEntry): void
  /** Notes that a recording was replayed, so a later failing check removes it. */
  replayed(key: string): void
  /** Removes a recording now: a hand-off the agent could not finish. */
  discard(key: string): Promise<void>
  /** A locator assertion or `agent.assert` finished: a pass writes what was staged, a failure deletes what it rested on. */
  onCheck(passed: boolean): Promise<void>
  /** Writes and deletes that the store refused; the cache is best effort and never fails a test. */
  readonly failures: number
}

export function defaultCacheMode(): CacheMode {
  return typeof process !== "undefined" && process.env.CI !== undefined && process.env.CI !== ""
    ? "read-only"
    : "read-write"
}

export function createCache(options: CacheOptions = {}): Cache {
  const mode = options.mode ?? defaultCacheMode()
  const store = options.store ?? fileCacheStore(options.dir ?? join(".nifra", "e2e-cache"))
  const testId = options.testId ?? ""
  const canWrite = mode === "read-write"
  const occurrences = new Map<string, number>()
  const staged = new Map<string, CacheEntry>()
  const used = new Set<string>()
  let failures = 0

  const guarded = async (work: Promise<void>): Promise<void> => {
    try {
      await work
    } catch {
      failures += 1
    }
  }

  return {
    mode,
    canWrite,
    get failures() {
      return failures
    },
    key(instruction, params, context) {
      const material = JSON.stringify([
        testId,
        instruction,
        keyParams(params),
        context ?? "",
        options.appIdentity ?? "",
      ])
      const seen = occurrences.get(material) ?? 0
      occurrences.set(material, seen + 1)
      return createHash("sha256").update(`${material}#${seen}`).digest("hex").slice(0, 32)
    },
    read: (key) => store.read(key),
    stage(key, entry) {
      staged.set(key, entry)
    },
    replayed(key) {
      used.add(key)
    },
    async discard(key) {
      staged.delete(key)
      used.delete(key)
      if (canWrite) await guarded(store.delete(key))
    },
    async onCheck(passed) {
      const writes = [...staged]
      const deletes = new Set([...staged.keys(), ...used])
      staged.clear()
      used.clear()
      if (!canWrite) return
      if (passed) {
        for (const [key, entry] of writes) await guarded(store.write(key, entry))
      } else {
        for (const key of deletes) await guarded(store.delete(key))
      }
    },
  }
}
