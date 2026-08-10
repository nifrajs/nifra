/** Versioned, token-only replay metadata shared by verification tools. */

export interface ReplayFile {
  readonly version: 1
  readonly gate: string
  readonly case: string
  readonly seed: string
  readonly inputsDigest: string
  readonly meta: Readonly<Record<string, unknown>>
}

/** Existing adversarial contract replay metadata. Kept as a compatibility envelope. */
export interface LegacyContractReplayFile {
  readonly seed: number
  readonly caseId: string
  readonly runtime: string
}

/** Existing deterministic failure-lab replay metadata. Kept as a compatibility envelope. */
export interface LegacyFailureReplayFile {
  readonly seed: number
  readonly schedule: readonly Record<string, unknown>[]
}

export type CompatibleReplayFile = ReplayFile | LegacyContractReplayFile | LegacyFailureReplayFile

export function defineReplayFile(input: Omit<ReplayFile, "version">): ReplayFile {
  if (input.gate.trim() === "" || input.case.trim() === "" || input.seed.trim() === "")
    throw new TypeError("replay metadata requires gate, case, and seed")
  if (!/^[a-f0-9]{64}$/.test(input.inputsDigest))
    throw new TypeError("replay inputsDigest must be a SHA-256 hex digest")
  return Object.freeze({ version: 1, ...input, meta: Object.freeze({ ...input.meta }) })
}

export function parseReplayFile(value: unknown): ReplayFile {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined
  if (record === undefined) throw new TypeError("invalid replay file")
  const meta =
    typeof record.meta === "object" && record.meta !== null && !Array.isArray(record.meta)
      ? Object.fromEntries(Object.entries(record.meta))
      : undefined
  const gate = typeof record.gate === "string" ? record.gate : undefined
  const caseId = typeof record.case === "string" ? record.case : undefined
  const seed = typeof record.seed === "string" ? record.seed : undefined
  const inputsDigest = typeof record.inputsDigest === "string" ? record.inputsDigest : undefined
  if (
    record.version !== 1 ||
    gate === undefined ||
    caseId === undefined ||
    seed === undefined ||
    inputsDigest === undefined ||
    meta === undefined
  ) {
    throw new TypeError("invalid replay file: expected version 1 metadata")
  }
  return defineReplayFile({
    gate,
    case: caseId,
    seed,
    inputsDigest,
    meta,
  })
}

/** Parse the unified format while preserving the two pre-existing token-only replay shapes. */
export function parseCompatibleReplayFile(value: unknown): CompatibleReplayFile {
  try {
    return parseReplayFile(value)
  } catch {
    const record =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined
    if (
      typeof record?.seed === "number" &&
      Number.isSafeInteger(record.seed) &&
      typeof record.caseId === "string" &&
      record.caseId.trim() !== "" &&
      typeof record.runtime === "string" &&
      record.runtime.trim() !== ""
    ) {
      return Object.freeze({ seed: record.seed, caseId: record.caseId, runtime: record.runtime })
    }
    if (
      typeof record?.seed === "number" &&
      Number.isSafeInteger(record.seed) &&
      Array.isArray(record.schedule)
    ) {
      return Object.freeze({ seed: record.seed, schedule: Object.freeze([...record.schedule]) })
    }
    throw new TypeError("invalid replay file: expected unified or legacy token-only metadata")
  }
}
