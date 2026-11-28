/**
 * Structured, redacting logger. The framework logs through this interface so
 * secrets/PII are scrubbed once, centrally (per the project's logging rule), not at
 * each call site. Bring your own by passing `logger` to `server()`.
 */

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

const REDACTED = "[REDACTED]"
const MAX_SCAN_LENGTH = 8192

/**
 * Field-name fragments whose values are replaced with `[REDACTED]` (case-insensitive
 * substring match). Key-name redaction is the default + always on.
 */
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|passwd|secret|token|apikey|api_key|api-key|credential|ssn/

/**
 * Tunes redaction. Key-name redaction always runs.
 * - `keyParts` - extra case-insensitive key fragments, added to the built-in denylist.
 * - `valuePatterns` - regexes matched against string **values** *and* the log message; each match is
 *   replaced with the placeholder. This is the value-scanning hook for secrets that land in a value or
 *   message (e.g. `err.message`), which key-name redaction can't catch. Defaults to
 *   {@link commonSecretPatterns} for `jsonLogger` and to no patterns for `redactLogFields`. Strings
 *   over 8,192 UTF-16 code units are replaced entirely when scanning in `jsonLogger`.
 * - `placeholder` - the replacement string (default `[REDACTED]`).
 */
export interface RedactOptions {
  readonly keyParts?: readonly string[]
  readonly valuePatterns?: readonly RegExp[]
  readonly placeholder?: string
}

/**
 * A conservative, high-signal set of patterns for {@link RedactOptions.valuePatterns}.
 * Covers bearer tokens, JWTs, emails, and a
 * few well-known key formats (Stripe, GitHub, AWS access-key ids). Chosen to minimize false positives;
 * add your own (e.g. internal id formats) as needed. Every pattern is global so all matches are scrubbed.
 */
export const commonSecretPatterns: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, // Authorization: Bearer <token>
  // JWT (header.payload.signature). The header stops before a `-eyJ` where a later attempt can start,
  // so a run of them is not rescanned from every one.
  /\beyJ(?:\w|-(?!eyJ[\w-]))+\.[\w-]+\.[\w-]+/g,
  // Email. The lookbehind starts a match only where a run of address characters starts; `\b` would
  // restart inside `a.a.a.` at every `a` and rescan the run each time, quadratic in its length.
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe-style secret/restricted keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub personal/OAuth/refresh tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
]

interface RedactConfig {
  readonly keyParts: readonly string[] | undefined
  readonly maxScanLength: number
  readonly valuePatterns: readonly RegExp[]
  readonly placeholder: string
}

// `String.replace` with a global regex replaces every match and is stateless across calls; a
// non-global pattern would only scrub the first occurrence, so normalize to global once up front.
const ensureGlobal = (re: RegExp): RegExp =>
  re.flags.includes("g") ? re : new RegExp(re.source, `${re.flags}g`)

function buildConfig(
  options?: RedactOptions,
  defaultPatterns: ReadonlyArray<RegExp> = [],
  maxScanLength = Infinity,
): RedactConfig {
  return {
    keyParts: options?.keyParts?.map((part) => part.toLowerCase()),
    maxScanLength,
    valuePatterns: (options?.valuePatterns ?? defaultPatterns).map(ensureGlobal),
    placeholder: options?.placeholder ?? REDACTED,
  }
}

function redactString(value: string, config: RedactConfig): string {
  if (config.valuePatterns.length === 0) return value
  if (value.length > config.maxScanLength) return config.placeholder
  let out = value
  for (const pattern of config.valuePatterns) out = out.replace(pattern, () => config.placeholder)
  return out
}

function redactValue(value: unknown, seen: WeakSet<object>, config: RedactConfig): unknown {
  if (typeof value === "string") return redactString(value, config)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return undefined
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, config))
  const out: Record<string, unknown> = Object.create(null)
  const entries = Object.entries(value)
  // An Error's own name and message are not enumerable.
  if (value instanceof Error) entries.unshift(["name", value.name], ["message", value.message])
  for (const [key, field] of entries) {
    // Lowercasing preserves Unicode matching. Custom fragments stay literal.
    const lower = key.toLowerCase()
    out[key] =
      SENSITIVE_KEY_PATTERN.test(lower) || config.keyParts?.some((part) => lower.includes(part))
        ? config.placeholder
        : redactValue(field, seen, config)
  }
  return out
}

/**
 * Deep-copy `fields`, replacing values under sensitive keys with the placeholder; cycle-safe. With
 * `options.valuePatterns`, also scans string values for those patterns (opt-in). Without options, this
 * is pure key-name redaction (the long-standing default).
 */
export function redactLogFields(fields: LogFields, options?: RedactOptions): LogFields {
  return redactValue(fields, new WeakSet(), buildConfig(options)) as LogFields
}

function writeToStderr(line: string): void {
  process.stderr.write(`${line}\n`)
}

/**
 * The default logger: one redacted JSON object per line. `write` is injectable for tests or
 * alternative sinks (defaults to stderr). `commonSecretPatterns` scrubs values and the log message
 * by default. Pass `valuePatterns` to replace those patterns. Framework keys
 * (`level`, `message`, `time`) always win over user fields of the same name.
 */
export function jsonLogger(
  write: (line: string) => void = writeToStderr,
  options?: RedactOptions,
): Logger {
  const config = buildConfig(options, commonSecretPatterns, MAX_SCAN_LENGTH)
  const emit = (level: string, message: string, fields?: LogFields): void => {
    const entry: Record<string, unknown> =
      fields === undefined
        ? {}
        : (redactValue(fields, new WeakSet(), config) as Record<string, unknown>)
    entry.level = level
    entry.message = redactString(message, config) // scan the message too (no-op without valuePatterns)
    entry.time = new Date().toISOString()
    write(JSON.stringify(entry))
  }
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  }
}

const noop = (): void => undefined

/** Discards everything - for tests, or when log output is handled elsewhere. */
export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}
