/**
 * `t.date()` across the wire, server half. JSON has no dates, so the output guard hands the page a
 * `WireDate`: a real `Date` for the server render that serializes as `{ "__nifra_date": iso }`. The
 * browser half (`revive-dates.ts`) rebuilds those tags, so both renders see the same value.
 */
import { DATE_TAG } from "./revive-dates.ts"

/** A `Date` that crosses JSON tagged, so the browser can tell it from a string that looks like one. */
export class WireDate extends Date {}
Object.defineProperty(WireDate.prototype, "toJSON", {
  value(this: Date): Readonly<Record<string, string>> {
    return { [DATE_TAG]: this.toISOString() }
  },
})
