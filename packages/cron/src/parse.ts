/**
 * Standard 5-field cron parsing + matching - `minute hour day-of-month month day-of-week`.
 * Pure and fully tested; the scheduler is a thin timer over `matches`. Minute granularity (the
 * cron standard). Each field supports a star, a star-step, a single value, a range, a range-step,
 * and comma lists of those - plus the common `@macros`.
 */

/** A parsed expression: one allowed-values Set per field, + whether dom/dow were restricted (for
 * the standard OR rule). */
export interface CronFields {
  readonly minute: ReadonlySet<number>
  readonly hour: ReadonlySet<number>
  readonly dom: ReadonlySet<number>
  readonly month: ReadonlySet<number>
  readonly dow: ReadonlySet<number>
  readonly domRestricted: boolean
  readonly dowRestricted: boolean
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

interface Range {
  readonly min: number
  readonly max: number
}
const RANGES: readonly [keyof Omit<CronFields, "domRestricted" | "dowRestricted">, Range][] = [
  ["minute", { min: 0, max: 59 }],
  ["hour", { min: 0, max: 23 }],
  ["dom", { min: 1, max: 31 }],
  ["month", { min: 1, max: 12 }],
  ["dow", { min: 0, max: 6 }],
]

const CRON_TERM = /^(?:\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/

/** Parse one field into the set of allowed values, validating against the field's range. */
function parseField(
  raw: string,
  { min, max }: Range,
  fieldName: string,
  expr: string,
): Set<number> {
  const out = new Set<number>()
  for (const part of raw.split(",")) {
    if (part === "") throw new CronError(`empty term in ${fieldName} field`, expr)
    // `*`, `n` or `a-b`, each with an optional `/step`. Decimal digits only: `Number()` would also
    // take `0x1F`, `1e1`, `+3` and an empty side of a range.
    const term = CRON_TERM.exec(part)
    if (term === null) throw new CronError(`invalid term "${part}" in ${fieldName} field`, expr)
    const [, start, end, stepText] = term
    const step = stepText === undefined ? 1 : Number(stepText)
    if (step < 1) throw new CronError(`invalid step "${stepText}" in ${fieldName} field`, expr)
    const lo = start === undefined ? min : Number(start)
    // A bare `n/step` runs from n to the field's end, as `*/step` runs from its start.
    const hi =
      end !== undefined ? Number(end) : start === undefined || stepText !== undefined ? max : lo
    if (lo < min || hi > max || lo > hi) {
      throw new CronError(
        `out-of-range value "${part}" in ${fieldName} field (${min}-${max})`,
        expr,
      )
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** Thrown on a malformed cron expression - loud at registration, never at fire time. */
export class CronError extends Error {
  constructor(reason: string, expr: string) {
    super(`[nifra/cron] invalid cron expression ${JSON.stringify(expr)}: ${reason}`)
    this.name = "CronError"
  }
}

/** Parse a 5-field cron expression (or a `@macro`) into matchable {@link CronFields}. */
export function parseCron(expression: string): CronFields {
  const expr = expression.trim()
  const normalized = MACROS[expr] ?? expr
  const parts = normalized.split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError(`expected 5 space-separated fields (got ${parts.length})`, expression)
  }
  const [minute, hour, dom, month, dow] = RANGES.map(([name, range], i) =>
    parseField(parts[i] as string, range, name, expression),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    // "restricted" = the raw field wasn't a bare `*` (controls the dom/dow OR rule in `matches`).
    domRestricted: (parts[2] as string) !== "*",
    dowRestricted: (parts[4] as string) !== "*",
  }
}

/**
 * Does `date` (in its LOCAL time - cron is local-time by convention) match the fields, to the
 * minute? Day-of-month and day-of-week follow the standard OR rule: when BOTH are restricted, a
 * match on EITHER is a match; when only one is restricted, only that one must match.
 */
export function matches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false
  if (!fields.hour.has(date.getHours())) return false
  if (!fields.month.has(date.getMonth() + 1)) return false
  const domOk = fields.dom.has(date.getDate())
  const dowOk = fields.dow.has(date.getDay())
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk
  if (fields.domRestricted) return domOk
  if (fields.dowRestricted) return dowOk
  return true
}

/**
 * The next instant at/after `from` (exclusive of the current minute's already-started second) that
 * matches. Steps minute-by-minute with a safety cap (~5 years) so a never-matching expression
 * returns `null` instead of looping forever.
 */
export function nextRun(fields: CronFields, from: Date): Date | null {
  // Start at the next whole minute (zero seconds/ms) so we never re-fire the current minute.
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const CAP = 5 * 366 * 24 * 60 // ~5 years of minutes
  for (let i = 0; i < CAP; i++) {
    if (matches(fields, d)) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}
