/**
 * What core's JSON walks share besides the writer: the `Date` hooks the response contract reads, the
 * `__proto__`-safe field setter. Apart from `json-text.ts` so the Node adapter's generated copy of that
 * module holds only the writer.
 */

export const DATE_TO_JSON = Date.prototype.toJSON
// What `Date.prototype.toJSON` reads a `Date`'s time value through.
const DATE_TO_PRIMITIVE = Date.prototype[Symbol.toPrimitive]
const DATE_VALUE_OF = Date.prototype.valueOf

/**
 * Whether `date` reaches the `@@toPrimitive` and `valueOf` that `Date.prototype.toJSON` reads its time
 * value through as they ship, on itself, its class or `Date.prototype`. Then its steps, taken by the
 * caller, give what the call would: `null` for a time value that is not finite, else what its
 * `toISOString` answers, called through it as `toJSON` calls it.
 */
export const readsShippedTime = (date: Date): boolean =>
  date[Symbol.toPrimitive] === DATE_TO_PRIMITIVE && date.valueOf === DATE_VALUE_OF

/** Sets `key` on `out` as an own field, `__proto__` included, which an assignment takes as the prototype. */
export function define(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__")
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  else out[key] = value
}
