import { FormatRegistry } from "@sinclair/typebox"

/**
 * Standard JSON Schema string formats, registered with TypeBox so `t.string({
 * format })` both **validates** and **annotates** the JSON Schema (the latter feeds
 * OpenAPI). This registration is the reason it works at all: TypeBox treats an
 * *unregistered* format as a hard failure, so without it `t.string({ format:
 * "email" })` would reject every value.
 *
 * Patterns are pragmatic (not full RFC grammars) but reject obvious garbage. Need a
 * stricter rule or a format not listed here (e.g. `ipv6`, `hostname`)? Register it
 * with {@link registerFormat}. Importing this module performs the registration as a
 * one-time side effect; the `Has` guard means an app that registered its own
 * validator first wins.
 */
const DEFAULT_FORMATS: Readonly<Record<string, RegExp>> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?$/,
  uri: /^[a-z][a-z0-9+.-]*:\S+$/i,
  ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/,
}

/** Register (or override) a string format usable as `t.string({ format: name })`. */
export function registerFormat(name: string, validate: (value: string) => boolean): void {
  FormatRegistry.Set(name, validate)
}

for (const [name, pattern] of Object.entries(DEFAULT_FORMATS)) {
  if (!FormatRegistry.Has(name)) FormatRegistry.Set(name, (value) => pattern.test(value))
}
