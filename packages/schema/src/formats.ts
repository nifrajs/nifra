import { FormatRegistry } from "@sinclair/typebox"

/**
 * Standard JSON Schema string formats, registered with TypeBox so `t.string({
 * format })` both **validates** and **annotates** the JSON Schema (the latter feeds
 * OpenAPI). This registration is the reason it works at all: TypeBox treats an
 * *unregistered* format as a hard failure, so without it `t.string({ format:
 * "email" })` would reject every value.
 *
 * Patterns are pragmatic (not full RFC grammars) but reject obvious garbage; `date-time`, `date`
 * and `time` follow RFC 3339 in full, calendar included. Need a stricter rule or a format not listed
 * here (e.g. `ipv6`, `hostname`)? Register it with {@link registerFormat}. The defaults are installed
 * lazily by {@link ensureDefaultFormats} from the validate path; the `Has` guard means an app that
 * registered its own validator first wins.
 */
const DEFAULT_FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  // Dot-separated labels that cannot contain a dot: linear on any input (an overlapping `[^\s@]+\.`
  // backtracks quadratically on a long run of dots).
  email: tested(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/),
  uuid: tested(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  "date-time": (value) => isDateTime(value, true),
  date: (value) => FULL_DATE.test(value) && dayExists(value),
  time: tested(
    /^(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/,
  ),
  uri: tested(/^[a-z][a-z0-9+.-]*:\S+$/i),
  ipv4: tested(/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/),
}

function tested(pattern: RegExp): (value: string) => boolean {
  return (value) => pattern.test(value)
}

// RFC 3339 with each field in range. What a pattern cannot say, the length of the month and the
// minute a leap second falls in, is read after a match, from digits the match vouches for.
const FULL_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const DATE_TIME =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[Tt](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

const twoDigits = (value: string, at: number): number =>
  (value.charCodeAt(at) - 48) * 10 + value.charCodeAt(at + 1) - 48

const yearOf = (value: string): number => twoDigits(value, 0) * 100 + twoDigits(value, 2)

/** Whether the matched `YYYY-MM-DD` at the start of `value` names a day its month has. */
function dayExists(value: string): boolean {
  const day = twoDigits(value, 8)
  if (day <= 28) return true
  const month = twoDigits(value, 5)
  if (month !== 2)
    return day <= (month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31)
  const year = yearOf(value)
  return day === 29 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** The matched date-time's UTC offset, in minutes. */
function offsetMinutes(value: string): number {
  const end = value.length
  const zone = value.charCodeAt(end - 1)
  if (zone === 90 || zone === 122) return 0
  const minutes = twoDigits(value, end - 5) * 60 + twoDigits(value, end - 2)
  return value.charCodeAt(end - 6) === 43 ? minutes : -minutes
}

/** Minutes past midnight UTC of the matched date-time's clock, out of 0-1439 when the offset crosses a
 * day. */
const utcMinutes = (value: string): number =>
  twoDigits(value, 11) * 60 + twoDigits(value, 14) - offsetMinutes(value)

const MINUTES_PER_DAY = 1440

/**
 * Whether `value` is an RFC 3339 `date-time`, calendar included (no `2026-02-30`). A leap second
 * (`:60`) holds only at `23:59` UTC, and only when `leapSeconds` is set, since a `Date` cannot
 * represent one.
 */
export function isDateTime(value: string, leapSeconds: boolean): boolean {
  if (!DATE_TIME.test(value)) return false
  const tens = value.charCodeAt(8)
  // The pattern allows a 6 there only as `60`.
  const leap = value.charCodeAt(17) === 54
  // Days 01-28 are in every month. Inline, since the call it saves costs a compiled check more than
  // the rest of this.
  if (!leap && (tens < 50 || (tens === 50 && value.charCodeAt(9) < 57))) return true
  if (!dayExists(value)) return false
  if (!leap) return true
  if (!leapSeconds) return false
  const minutes = utcMinutes(value) % MINUTES_PER_DAY
  return (minutes + MINUTES_PER_DAY) % MINUTES_PER_DAY === MINUTES_PER_DAY - 1
}

const MS_PER_DAY = 86_400_000
const FRACTION_SCALE = [100, 10, 1]

/**
 * Days from 1970-01-01 to a proleptic Gregorian date, by H. Hinnant's `days_from_civil`. `Date.UTC`
 * costs more than the rest of a parse, and reads a year below 100 as 19xx.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

/**
 * The instant an RFC 3339 `date-time` names, in ms since the epoch, or `NaN` when `value` is not one
 * a `Date` can hold (see {@link isDateTime}). Read without the engine's `Date` parser, whose leniency
 * differs between runtimes; past a millisecond the fraction is dropped, as a `Date` holds no finer.
 */
export function dateTimeMs(value: string): number {
  if (!isDateTime(value, false)) return Number.NaN
  let ms = 0
  if (value.charCodeAt(19) === 46)
    for (let i = 0; i < FRACTION_SCALE.length; i++) {
      const digit = value.charCodeAt(20 + i) - 48
      if (digit < 0 || digit > 9) break
      ms += digit * (FRACTION_SCALE[i] ?? 0)
    }
  const days = daysFromCivil(yearOf(value), twoDigits(value, 5), twoDigits(value, 8))
  return days * MS_PER_DAY + (utcMinutes(value) * 60 + twoDigits(value, 17)) * 1000 + ms
}

/** Register (or override) a string format usable as `t.string({ format: name })`. */
export function registerFormat(name: string, validate: (value: string) => boolean): void {
  FormatRegistry.Set(name, validate)
}

let defaultsRegistered = false

/**
 * Install the standard string formats into TypeBox's global `FormatRegistry`, once.
 *
 * This is driven from the validate path (see `./adapter.ts`) rather than run as a bare
 * top-level import side effect *on purpose*: a production bundler (`Bun.build`, esbuild)
 * tree-shakes a module that is only imported for its effect, and Bun.build does **not**
 * honor the `sideEffects` package.json field - so the old top-level registration loop was
 * dropped from prod server bundles, making every `t.string({ format })` reject with
 * "Unknown format" while unbundled `nifra dev` worked. Calling this from code the validator
 * actually reaches keeps the registration in the bundle.
 *
 * Idempotent and cheap to call on every validate (a single boolean check after the first
 * run). The `Has` guard means a format a consumer registered first via {@link registerFormat}
 * is left untouched.
 */
export function ensureDefaultFormats(): void {
  if (defaultsRegistered) return
  defaultsRegistered = true
  for (const [name, validate] of Object.entries(DEFAULT_FORMATS)) {
    if (!FormatRegistry.Has(name)) FormatRegistry.Set(name, validate)
  }
}
