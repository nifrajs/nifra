/**
 * Coercing env validators. Every value in `process.env` is a `string | undefined`, so these turn
 * that into the typed value you actually want — with defaults, optionality, and clear errors. Each
 * is a Standard Schema, so they slot straight into {@link defineEnv} (and could be used anywhere a
 * Standard Schema is accepted).
 *
 * Error messages are **value-free** — they say what was wrong, never echo the variable's value
 * (it may be a secret). {@link defineEnv} prepends the variable name.
 */

import { envSchema, issue, type StandardSchemaV1 } from "./schema.ts"

interface Base<T> {
  /** Used when the variable is unset/empty. Makes the variable optional-with-a-fallback. */
  readonly default?: T
}
interface Optional {
  /** When true, an unset variable yields `undefined` instead of being an error. */
  readonly optional?: boolean
}

const isUnset = (raw: string | undefined): boolean => raw === undefined || raw === ""

/** A required (or defaulted/optional) non-empty string. */
export function string(opts: Base<string> & Optional = {}): StandardSchemaV1<string | undefined> {
  return envSchema((raw) => {
    if (isUnset(raw)) {
      if (opts.default !== undefined) return { value: opts.default }
      if (opts.optional) return { value: undefined }
      return issue("is required")
    }
    return { value: raw }
  })
}

/** A finite number, coerced from its decimal string. */
export function number(opts: Base<number> & Optional = {}): StandardSchemaV1<number | undefined> {
  return envSchema((raw) => {
    if (isUnset(raw)) {
      if (opts.default !== undefined) return { value: opts.default }
      if (opts.optional) return { value: undefined }
      return issue("is required")
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) return issue("must be a number")
    return { value: n }
  })
}

/** A TCP port: an integer in 1–65535. */
export function port(opts: Base<number> = {}): StandardSchemaV1<number> {
  return envSchema((raw) => {
    if (isUnset(raw)) {
      if (opts.default !== undefined) return { value: opts.default }
      return issue("is required")
    }
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return issue("must be an integer port in 1–65535")
    }
    return { value: n }
  }) as StandardSchemaV1<number>
}

const TRUE = new Set(["true", "1", "yes", "on"])
const FALSE = new Set(["false", "0", "no", "off", ""])

/** A boolean: `true`/`1`/`yes`/`on` → true; `false`/`0`/`no`/`off`/empty → false (case-insensitive). */
export function boolean(opts: Base<boolean> = {}): StandardSchemaV1<boolean> {
  return envSchema((raw) => {
    if (raw === undefined) {
      if (opts.default !== undefined) return { value: opts.default }
      return issue("is required")
    }
    const v = raw.trim().toLowerCase()
    if (TRUE.has(v)) return { value: true }
    if (FALSE.has(v)) return { value: false }
    return issue("must be a boolean (true/false/1/0/yes/no/on/off)")
  }) as StandardSchemaV1<boolean>
}

/** One of a fixed set of string values. */
export function enumValue<const V extends readonly [string, ...string[]]>(
  values: V,
  opts: Base<V[number]> = {},
): StandardSchemaV1<V[number]> {
  const set = new Set<string>(values)
  return envSchema((raw) => {
    if (raw === undefined || raw === "") {
      if (opts.default !== undefined) return { value: opts.default }
      return issue(`is required (one of: ${values.join(", ")})`)
    }
    if (!set.has(raw)) return issue(`must be one of: ${values.join(", ")}`)
    return { value: raw as V[number] }
  }) as StandardSchemaV1<V[number]>
}

/** A valid absolute URL (parses with the WHATWG `URL`). Returns the normalized href string. */
export function url(opts: Base<string> & Optional = {}): StandardSchemaV1<string | undefined> {
  return envSchema((raw) => {
    if (raw === undefined || raw === "") {
      if (opts.default !== undefined) return { value: opts.default }
      if (opts.optional) return { value: undefined }
      return issue("is required")
    }
    try {
      return { value: new URL(raw).href }
    } catch {
      return issue("must be a valid URL")
    }
  })
}

/** The coercing env validators, grouped — `env.string()`, `env.port()`, `env.enum([...])`, … */
export const env = {
  string,
  number,
  port,
  boolean,
  enum: enumValue,
  url,
}
