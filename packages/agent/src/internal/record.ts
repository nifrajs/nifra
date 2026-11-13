/** A non-null, non-array object. The prototype is not checked: a `Date` or a `Map` passes. */
import { isRecord } from "@nifrajs/utils/record"

export { isRecord }

/** `value` as a record, or `undefined` when {@link isRecord} refuses it. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}
