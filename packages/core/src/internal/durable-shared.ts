import type { ReconciliationScanOptions, ReconciliationScanPage } from "./durable-types.ts"

export const TOKEN = /^[!-~]+$/
export const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/
export const encoder = new TextEncoder()

export function assertToken(value: string, label: string, maxLength = 255): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !TOKEN.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded printable token`)
  }
}

export function assertPositiveMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${label} must be a positive safe integer`)
}

export function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer timestamp`)
}

export function readClock(clock: () => number, label: string): number {
  const value = clock()
  assertTimestamp(value, label)
  return value
}

export function addDuration(timestamp: number, duration: number, label: string): number {
  const result = timestamp + duration
  assertTimestamp(result, label)
  return result
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

export async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
  )
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

export const DEFAULT_RECONCILIATION_LIMIT = 100
export const MAX_RECONCILIATION_LIMIT = 1_000

export function reconciliationLimit(value = DEFAULT_RECONCILIATION_LIMIT): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECONCILIATION_LIMIT) {
    throw new RangeError(`reconciliation limit must be between 1 and ${MAX_RECONCILIATION_LIMIT}`)
  }
  return value
}

/**
 * One page of `matches` in id order, the cursor being the last id returned. Keyed rather than an
 * offset into the matching set: a caller reconciles each page before asking for the next, so the
 * set shrinks under it, and an offset then lands past records that were never returned.
 */
function keysetPage<Record>(
  matches: [id: string, record: Record][],
  limit: number,
): ReconciliationScanPage<Record> {
  // Code-unit order, the order the `id > cursor` comparisons use.
  matches.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const page = matches.slice(0, limit)
  const records = Object.freeze(page.map(([, record]) => cloneValue(record)))
  const last = page.at(-1)
  if (matches.length <= limit || last === undefined) return Object.freeze({ records })
  return Object.freeze({ records, cursor: last[0] })
}

export function memoryScan<
  Record extends { readonly state: State; readonly updatedAt: number },
  State extends string,
>(
  source: Iterable<Record>,
  idOf: (record: Record) => string,
  input: ReconciliationScanOptions<State>,
): ReconciliationScanPage<Record> {
  const states = new Set(input.states)
  const matches: [string, Record][] = []
  for (const record of source) {
    if (!states.has(record.state)) continue
    if (input.updatedBefore !== undefined && record.updatedAt > input.updatedBefore) continue
    const id = idOf(record)
    if (input.cursor === undefined || id > input.cursor) matches.push([id, record])
  }
  return keysetPage(matches, input.limit)
}

export function bucketAdd<State extends string>(
  byState: Map<State, Set<string>>,
  state: State,
  id: string,
): void {
  let bucket = byState.get(state)
  if (bucket === undefined) {
    bucket = new Set()
    byState.set(state, bucket)
  }
  bucket.add(id)
}

export function bucketMove<State extends string>(
  byState: Map<State, Set<string>>,
  from: State,
  to: State,
  id: string,
): void {
  if (from === to) return
  byState.get(from)?.delete(id)
  bucketAdd(byState, to, id)
}

export function indexedScan<Record extends { readonly updatedAt: number }, State extends string>(
  byState: Map<State, Set<string>>,
  resolve: (id: string) => Record | undefined,
  input: ReconciliationScanOptions<State>,
): ReconciliationScanPage<Record> {
  const matches: [string, Record][] = []
  for (const state of new Set(input.states)) {
    const bucket = byState.get(state)
    if (bucket === undefined) continue
    for (const id of bucket) {
      if (input.cursor !== undefined && id <= input.cursor) continue
      const record = resolve(id)
      if (record === undefined) continue
      if (input.updatedBefore !== undefined && record.updatedAt > input.updatedBefore) continue
      matches.push([id, record])
    }
  }
  return keysetPage(matches, input.limit)
}
