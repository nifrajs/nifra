/**
 * What a process applies the ordered live events to, wherever they come from: a bus every process
 * reads, or the Workers hub that owns the log.
 */
import type { LiveBusEvent, LiveRevocation } from "./bus.ts"
import type { History } from "./history.ts"
import type { LiveHub } from "./hub.ts"
import { KEY_PATTERN, type Keyring } from "./keyring.ts"
import type { Revocations } from "./revocations.ts"

export interface LiveCore {
  readonly ring: Keyring
  readonly history: History
  readonly revocations: Revocations
  readonly hub: LiveHub
}

/**
 * Apply one event. A change is recorded in history and then fanned out in one synchronous step; a
 * revocation is stored before any socket hears of it. Throws on an event it cannot apply, which
 * leaves history and revocations unknown: the caller forgets everything up to its seq.
 */
export async function applyEvent(
  core: LiveCore,
  event: LiveBusEvent,
  hash: (key: string) => number,
): Promise<void> {
  if (event.type === "change") {
    const keys = event.keys.filter((key) => typeof key === "string" && KEY_PATTERN.test(key))
    const tags = await Promise.all(keys.map((key) => core.hub.tagsOf(key)))
    core.history.record(
      event.seq,
      keys.map((key) => hash(key)),
      Date.now(),
    )
    core.hub.change(keys, tags)
    return
  }
  if (!validRevocation(event)) throw new TypeError("malformed revocation")
  const tags = event.key === null ? [] : await core.hub.tagsOf(event.key)
  core.revocations.apply(event, Date.now())
  core.history.advance(event.seq, Date.now())
  core.hub.revoke(event, tags)
}

export function validRevocation(event: LiveBusEvent): event is LiveRevocation & {
  readonly seq: number
} {
  if (event.type !== "revoke") return false
  if (event.sub !== null && typeof event.sub !== "string") return false
  return event.key === null || (typeof event.key === "string" && KEY_PATTERN.test(event.key))
}
