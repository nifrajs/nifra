/**
 * The private calls between a Workers isolate and the app's live hub, over the Durable Object binding.
 * Nothing on the internet reaches a Durable Object except through the app's own isolate, which
 * forwards only the socket handshake; the paths below are refused on every public route.
 */
import type { LiveBusInput } from "./bus.ts"
import { KEY_PATTERN, type Keyring, MAX_KEYS_PER_FRAME } from "./keyring.ts"
import type { RevocationSnapshot } from "./revocations.ts"

/** A Durable Object namespace, as far as the runtime uses one (no Cloudflare types dependency). */
export interface LiveHubNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

export const HUB_APPEND_PATH = "/__nifra_live_hub/append"
export const HUB_AUTHORITY_PATH = "/__nifra_live_hub/authority"
/** The host the calls name; a Durable Object stub ignores it. */
export const HUB_ORIGIN = "https://nifra-live-hub"

/** One hub per app. */
export const hubName = (appId: string): string => `nifra-live:${appId}`

/**
 * What an isolate's live runtime and its hub must agree on, sent with every call: the grant lifetime
 * sets how long the hub keeps a revocation, so a hub with a shorter one would forget revocations of
 * grants still valid. The secret is named by its public id only.
 */
export const HUB_CONFIG_HEADER = "x-nifra-live-config"

export const hubConfigOf = (ring: Keyring): string =>
  `${ring.ttl} ${ring.secretIds[0] ?? 0} ${encodeURIComponent(ring.appId)}`

/** The caller's newest secret must be one the hub holds; the hub may already hold a newer one. */
export function hubConfigMatches(ring: Keyring, header: string | null): boolean {
  const parts = header?.split(" ")
  if (parts?.length !== 3) return false
  const [ttl, id, appId] = parts
  return (
    ttl === String(ring.ttl) &&
    ring.secretIds.some((own) => String(own) === id) &&
    appId === encodeURIComponent(ring.appId)
  )
}

/** Grants a load presents, at most. */
const MAX_SUBJECTS = 3
const MAX_KEYS = MAX_SUBJECTS * MAX_KEYS_PER_FRAME
export const MAX_SUBJECT_CHARS = 1024

export interface AuthorityRequest {
  readonly subjects: readonly string[]
  readonly keys: readonly string[]
}

export interface AuthorityReply extends RevocationSnapshot {
  /** The hub's seq: a load's watermark. */
  readonly seq: number
}

export function parseAppend(value: unknown): LiveBusInput | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === "change") {
    const keys = value.keys
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) return undefined
    const list: string[] = []
    for (const key of keys) {
      if (typeof key !== "string" || !KEY_PATTERN.test(key)) return undefined
      list.push(key)
    }
    return { type: "change", keys: list }
  }
  if (value.type !== "revoke") return undefined
  const { sub, key } = value
  if (sub !== null && !subjectLike(sub)) return undefined
  if (key !== null && (typeof key !== "string" || !KEY_PATTERN.test(key))) return undefined
  return { type: "revoke", sub, key }
}

export function parseAuthorityRequest(value: unknown): AuthorityRequest | undefined {
  if (!isRecord(value)) return undefined
  const { subjects, keys } = value
  if (!Array.isArray(subjects) || subjects.length > MAX_SUBJECTS) return undefined
  if (!Array.isArray(keys) || keys.length > MAX_KEYS) return undefined
  const subjectList: string[] = []
  for (const sub of subjects) {
    if (!subjectLike(sub)) return undefined
    subjectList.push(sub)
  }
  const keyList: string[] = []
  for (const key of keys) {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) return undefined
    keyList.push(key)
  }
  return { subjects: subjectList, keys: keyList }
}

export function parseAuthorityReply(value: unknown): AuthorityReply | undefined {
  if (!isRecord(value)) return undefined
  const { seq, floor } = value
  if (!seqLike(seq) || !seqLike(floor)) return undefined
  const subjects = stampsOf(value.subjects)
  const keys = stampsOf(value.keys)
  const subjectKeys = stampsOf(value.subjectKeys)
  if (subjects === undefined || keys === undefined || subjectKeys === undefined) return undefined
  return { seq, floor, subjects, keys, subjectKeys }
}

export function parseSeq(value: unknown): number | undefined {
  return isRecord(value) && seqLike(value.seq) && value.seq > 0 ? value.seq : undefined
}

function stampsOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, number> = {}
  for (const [name, seq] of Object.entries(value)) {
    if (!seqLike(seq)) return undefined
    out[name] = seq
  }
  return out
}

const seqLike = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const subjectLike = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_SUBJECT_CHARS

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
