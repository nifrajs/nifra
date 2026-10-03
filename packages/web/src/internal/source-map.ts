/**
 * Source map v3 decoding, encoding and lookup, shared by the browser-frame mapper, the dev server's
 * SSR frame remap and the SFC plugins that join several compiler outputs into one module. Node-free.
 */

/** A source map as its v3 JSON object. */
export interface RawSourceMap {
  /** `3`; some compilers type it as the string. */
  readonly version: number | string
  readonly sources: readonly string[]
  readonly sourcesContent?: readonly (string | null)[] | undefined
  readonly names?: readonly string[] | undefined
  readonly mappings: string
  readonly file?: string | undefined
}

/** One generated line's segments, flattened: [column, source, line, column] per segment, all absolute. */
export type MappingLine = Int32Array

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const BASE64_VALUE = new Int8Array(128).fill(-1)
for (let i = 0; i < BASE64.length; i++) BASE64_VALUE[BASE64.charCodeAt(i)] = i

/** Decode a source map v3 `mappings` string. Segments without a source are dropped. */
export function decodeMappings(mappings: string): MappingLine[] {
  const lines: MappingLine[] = []
  let segment: number[] = []
  let current: number[] = []
  let generatedColumn = 0
  let source = 0
  let sourceLine = 0
  let sourceColumn = 0
  let value = 0
  let shift = 0
  const endSegment = (): void => {
    if (segment.length === 0) return
    generatedColumn += segment[0] ?? 0
    if (segment.length >= 4) {
      source += segment[1] ?? 0
      sourceLine += segment[2] ?? 0
      sourceColumn += segment[3] ?? 0
      current.push(generatedColumn, source, sourceLine, sourceColumn)
    }
    segment = []
  }
  for (let i = 0; i < mappings.length; i++) {
    const code = mappings.charCodeAt(i)
    if (code === 44 /* , */) {
      endSegment()
      continue
    }
    if (code === 59 /* ; */) {
      endSegment()
      lines.push(Int32Array.from(current))
      current = []
      generatedColumn = 0
      continue
    }
    const digit = code < 128 ? (BASE64_VALUE[code] ?? -1) : -1
    if (digit === -1) throw new Error(`invalid VLQ character at ${i}`)
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
      continue
    }
    segment.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  endSegment()
  lines.push(Int32Array.from(current))
  return lines
}

function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let out = ""
  do {
    let digit = rest & 31
    rest >>>= 5
    if (rest > 0) digit |= 32
    out += BASE64[digit]
  } while (rest > 0)
  return out
}

/** Encode decoded lines back into a `mappings` string. */
export function encodeMappings(lines: readonly MappingLine[]): string {
  let source = 0
  let sourceLine = 0
  let sourceColumn = 0
  return lines
    .map((segments) => {
      let generatedColumn = 0
      const parts: string[] = []
      for (let i = 0; i + 3 < segments.length; i += 4) {
        const column = segments[i] ?? 0
        const s = segments[i + 1] ?? 0
        const l = segments[i + 2] ?? 0
        const c = segments[i + 3] ?? 0
        parts.push(
          vlq(column - generatedColumn) +
            vlq(s - source) +
            vlq(l - sourceLine) +
            vlq(c - sourceColumn),
        )
        generatedColumn = column
        source = s
        sourceLine = l
        sourceColumn = c
      }
      return parts.join(",")
    })
    .join(";")
}

/** The source position for a 0-based generated line/column: the last segment at or before it. */
export function lookupPosition(
  lines: readonly (MappingLine | undefined)[],
  line: number,
  column: number,
): { readonly source: number; readonly line: number; readonly column: number } | undefined {
  const segments = lines[line]
  if (segments === undefined || segments.length === 0) return undefined
  let low = 0
  let high = segments.length / 4 - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >>> 1
    if ((segments[mid * 4] ?? 0) <= column) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  if (found === -1) found = 0
  return {
    source: segments[found * 4 + 1] ?? 0,
    line: (segments[found * 4 + 2] ?? 0) + 1,
    column: (segments[found * 4 + 3] ?? 0) + 1,
  }
}

const decoded = new WeakMap<RawSourceMap, MappingLine[]>()

/** Where a 1-based generated line/column came from in `map`'s first-listed sources, 1-based. */
export function originalPosition(
  map: RawSourceMap,
  line: number,
  column: number,
): { readonly line: number; readonly column: number } | undefined {
  let lines = decoded.get(map)
  if (lines === undefined) {
    lines = decodeMappings(map.mappings)
    decoded.set(map, lines)
  }
  const found = lookupPosition(lines, line - 1, column - 1)
  return found === undefined ? undefined : { line: found.line, column: found.column }
}

const INLINE_MAP = /\/\/[#@] sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/

/** The map a module carries as a trailing base64 `sourceMappingURL` comment, when it does. */
export function inlineSourceMap(code: string): RawSourceMap | undefined {
  const found = INLINE_MAP.exec(code.slice(-4 * 1024 * 1024))
  if (found === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(atob(found[1] ?? ""))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const mappings: unknown = Reflect.get(parsed, "mappings")
  const sources: unknown = Reflect.get(parsed, "sources")
  if (typeof mappings !== "string" || !Array.isArray(sources)) return undefined
  return {
    version: 3,
    sources: sources.map((source) => (typeof source === "string" ? source : "")),
    mappings,
  }
}

/**
 * One map over parts joined with no separator, each part either mapped by its own map or unmapped
 * (generated glue). Sources are merged by name.
 */
export function concatSourceMaps(
  parts: readonly { readonly code: string; readonly map?: RawSourceMap | undefined }[],
): RawSourceMap {
  const sources: string[] = []
  const sourcesContent: (string | null)[] = []
  const out: number[][] = [[]]
  for (const part of parts) {
    const lineOffset = out.length - 1
    // A part that starts mid-line shifts its first line's columns by what is already on that line.
    const columnOffset = lastLineLength(parts, part)
    if (part.map !== undefined) {
      const index = part.map.sources.map((source, i) => {
        let at = sources.indexOf(source)
        if (at === -1) {
          at = sources.push(source) - 1
          sourcesContent.push(part.map?.sourcesContent?.[i] ?? null)
        }
        return at
      })
      decodeMappings(part.map.mappings).forEach((segments, line) => {
        const target = out[lineOffset + line] ?? []
        out[lineOffset + line] = target
        for (let i = 0; i + 3 < segments.length; i += 4) {
          target.push(
            (segments[i] ?? 0) + (line === 0 ? columnOffset : 0),
            index[segments[i + 1] ?? 0] ?? 0,
            segments[i + 2] ?? 0,
            segments[i + 3] ?? 0,
          )
        }
      })
    }
    const newlines = part.code.split("\n").length - 1
    for (let i = 0; i < newlines; i++) out[lineOffset + 1 + i] ??= []
  }
  return {
    version: 3,
    sources,
    sourcesContent,
    names: [],
    mappings: encodeMappings(out.map((line) => Int32Array.from(line))),
  }
}

function lastLineLength(
  parts: readonly { readonly code: string }[],
  until: { readonly code: string },
): number {
  let length = 0
  for (const part of parts) {
    if (part === until) return length
    const newline = part.code.lastIndexOf("\n")
    length = newline === -1 ? length + part.code.length : part.code.length - newline - 1
  }
  return length
}

const REGISTRY = Symbol.for("nifra.dev.ssrSourceMaps")

/**
 * The maps of modules a dev plugin compiled for SSR, by file path. Bun's runtime ignores a plugin's
 * inline map, so a server stack names the compiled line; the dev server remaps through this.
 */
export function ssrSourceMaps(): Map<string, RawSourceMap> {
  const existing: unknown = Reflect.get(globalThis, REGISTRY)
  if (existing instanceof Map) return existing
  const created = new Map<string, RawSourceMap>()
  Reflect.set(globalThis, REGISTRY, created)
  return created
}
