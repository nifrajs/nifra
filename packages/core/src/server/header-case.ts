import { NODE_BRIDGE_MARKER_KEYS } from "./bridge-markers.ts"

/**
 * The all-lowercase header-name proof: one answer, computed once per request, read by everyone who
 * would otherwise re-derive it.
 *
 * "Are these header names already the lowercase wire spelling?" is asked on every Node-direct
 * response by the implicit-Content-Type lookup in the native response walk, by the portable header
 * view's alias index, and by the `@nifrajs/node` writer's normalization gate. Each used to answer it
 * by walking the same keys. Instead, whichever stage has ALREADY looked at the names - the static
 * merge, which lowercases every own key anyway, or the native walk - records the answer on the
 * record, and the readers take it.
 *
 * The mark is a plain enumerable symbol assignment on purpose. `Object.keys`, `Object.entries` and
 * `for...in` never see symbol keys, so it cannot reach the wire, while a non-enumerable
 * `defineProperty` would demote the record to V8's dictionary mode - the exact cost the record's `{}`
 * literal shape exists to avoid. Spread and `Object.assign` DO copy it, which is what the clone paths
 * want: a clone of an all-lowercase record is still all-lowercase.
 *
 * It is only ever SET where its truth is provable, and only where every writer that can still touch
 * the record afterwards is case-normalizing. An app registering a raw `onNodeResponse` twin - handed
 * the record itself rather than the case-normalizing view - is left unmarked, and every reader
 * re-derives the answer exactly as it did before the mark existed.
 *
 * Declared with `Symbol.for` so the `@nifrajs/node` adapter can read it by key rather than importing
 * across the package boundary - the same cross-package convention as the body and result marks.
 */
const LOWERCASE_HEADER_KEYS = Symbol.for(NODE_BRIDGE_MARKER_KEYS.lowercaseHeaderKeys)

/** True when the name contains an ASCII `A`-`Z`, i.e. is not already the wire spelling. */
export function hasUpperAscii(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code >= 65 && code <= 90) return true
  }
  return false
}

/** True when every name in the record is already the lowercase wire spelling. */
export function headerKeysAllLowercase(record: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(record)
  for (let i = 0; i < keys.length; i++) {
    if (hasUpperAscii(keys[i] as string)) return false
  }
  return true
}

/** Record the {@link LOWERCASE_HEADER_KEYS} proof on a record the caller has just verified. */
export function markLowercaseHeaderKeys(record: Record<string, string | readonly string[]>): void {
  ;(record as Record<symbol, unknown>)[LOWERCASE_HEADER_KEYS] = true
}

/** True when this record carries the proof - never a claim the reader has to re-check. */
export function hasLowercaseHeaderKeysMark(record: Readonly<Record<string, unknown>>): boolean {
  return (record as Record<symbol, unknown>)[LOWERCASE_HEADER_KEYS] === true
}
