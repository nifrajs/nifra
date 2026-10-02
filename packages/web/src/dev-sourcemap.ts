/**
 * Maps a browser stack trace back to source files, using the source maps the dev server itself
 * serves (Bun links `/_bun/client/<gen>.js.map`; Vite inlines a data URL per module).
 *
 * Every fetch goes to the dev server's own origin, whatever host a frame names, so a crafted frame
 * cannot make the server request anything else. Browser stacks in any engine's format come out as
 * V8 `at` frames, which is what {@link parseFrames} reads.
 */

import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface SourceMapperOptions {
  readonly root: string
  /** The dev server's own origin (`http://127.0.0.1:<port>`), or undefined before it listens. */
  readonly origin: () => string | undefined
  readonly fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  /** Decoded maps kept, most recently used first. */
  readonly maxMaps?: number
}

export interface SourceMapper {
  /** `stack` with each frame of a script this server served pointed at its source file. */
  mapStack(stack: string): Promise<string>
  /** Forget every map: the code they describe changed. */
  clear(): void
}

interface Frame {
  readonly name: string | undefined
  readonly url: string
  readonly line: number
  readonly column: number
}

// V8: `    at fn (url:1:2)` / `    at url:1:2` / `    at async fn (url:1:2)`.
const V8_FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/
// SpiderMonkey / JavaScriptCore: `fn@url:1:2` / `@url:1:2`.
const AT_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/
const MAX_FRAMES = 50
const SCRIPT_PATH = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx)$/i
const MAX_SCRIPT_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 5_000

function parseFrame(line: string): Frame | undefined {
  const match = V8_FRAME.exec(line) ?? AT_FRAME.exec(line)
  if (match === null) return undefined
  const [, name, url = "", lineText = "", columnText = ""] = match
  return {
    name: name === undefined || name === "" ? undefined : name.replace(/^async\s+/, ""),
    url,
    line: Number(lineText),
    column: Number(columnText),
  }
}

// ---------------------------------------------------------------------------------------------------
// VLQ mappings
// ---------------------------------------------------------------------------------------------------

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const BASE64_VALUE = new Int8Array(128).fill(-1)
for (let i = 0; i < BASE64.length; i++) BASE64_VALUE[BASE64.charCodeAt(i)] = i

/** One generated line's segments, flattened: [column, source, line, column] per segment, all absolute. */
type Line = Int32Array

interface DecodedMap {
  readonly sources: readonly string[]
  readonly lines: readonly (Line | undefined)[]
}

/** Decode a source map v3 `mappings` string. Segments without a source are dropped. */
export function decodeMappings(mappings: string): Line[] {
  const lines: Line[] = []
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

/** The source position for a 0-based generated line/column: the last segment at or before it. */
function lookup(
  map: DecodedMap,
  line: number,
  column: number,
): { source: string; line: number; column: number } | undefined {
  const segments = map.lines[line]
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
  const source = map.sources[segments[found * 4 + 1] ?? -1]
  if (source === undefined) return undefined
  return {
    source,
    line: (segments[found * 4 + 2] ?? 0) + 1,
    column: (segments[found * 4 + 3] ?? 0) + 1,
  }
}

// ---------------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const SOURCE_MAPPING_URL = /[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/

function sourceMappingUrl(script: string): string | undefined {
  // The comment is the last one in the file; a data URL can be megabytes, so look from the end.
  const at = script.lastIndexOf("sourceMappingURL=")
  if (at === -1) return undefined
  const lineStart = script.lastIndexOf("\n", at) + 1
  return SOURCE_MAPPING_URL.exec(script.slice(lineStart))?.[1]
}

function decodeDataUrl(url: string): string | undefined {
  const comma = url.indexOf(",")
  if (comma === -1) return undefined
  const meta = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  return meta.endsWith(";base64")
    ? Buffer.from(payload, "base64").toString("utf8")
    : decodeURIComponent(payload)
}

/**
 * The directory a served script lives in on disk. Vite serves files outside the root as
 * `/@fs/<absolute path>`; everything else maps onto the project root.
 */
function scriptDirectory(scriptPath: string, root: string): string {
  const dir = decodeURIComponent(scriptPath.replace(/[^/]*$/, ""))
  return dir.startsWith("/@fs/") ? dir.slice(4) : resolve(root, `.${dir}`)
}

/** The filesystem path a map's source names, when it is a file. */
function sourcePath(source: string, sourceRoot: string, scriptPath: string, root: string): string {
  const joined = sourceRoot === "" ? source : `${sourceRoot.replace(/\/?$/, "/")}${source}`
  if (joined.startsWith("file://")) {
    try {
      return fileURLToPath(joined)
    } catch {
      return joined
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(joined)) return joined
  if (isAbsolute(joined)) return joined
  // Relative to the script's own location, as a map's sources always are.
  return resolve(scriptDirectory(scriptPath, root), joined)
}

export function createSourceMapper(options: SourceMapperOptions): SourceMapper {
  const root = resolve(options.root)
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
  const maxMaps = options.maxMaps ?? 8
  const maps = new Map<string, Promise<DecodedMap | undefined>>()

  const fetchText = async (url: string): Promise<string | undefined> => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const length = Number(response.headers.get("content-length") ?? "0")
    if (length > MAX_SCRIPT_BYTES) return undefined
    const text = await response.text()
    return text.length > MAX_SCRIPT_BYTES ? undefined : text
  }

  const load = async (origin: string, pathAndQuery: string): Promise<DecodedMap | undefined> => {
    const scriptUrl = new URL(pathAndQuery, origin)
    const script = await fetchText(scriptUrl.href)
    if (script === undefined) return undefined
    const reference = sourceMappingUrl(script)
    if (reference === undefined) return undefined
    let text: string | undefined
    if (reference.startsWith("data:")) text = decodeDataUrl(reference)
    else {
      const mapUrl = new URL(reference, scriptUrl)
      // Same server only: the map's URL comes from a script body, and a body is data.
      if (mapUrl.origin !== scriptUrl.origin) return undefined
      text = await fetchText(mapUrl.href)
    }
    if (text === undefined) return undefined
    const raw: unknown = JSON.parse(text)
    if (!isRecord(raw) || typeof raw.mappings !== "string" || !Array.isArray(raw.sources))
      return undefined
    const sourceRoot = typeof raw.sourceRoot === "string" ? raw.sourceRoot : ""
    return {
      sources: raw.sources.map((source) =>
        typeof source === "string" ? sourcePath(source, sourceRoot, scriptUrl.pathname, root) : "",
      ),
      lines: decodeMappings(raw.mappings),
    }
  }

  const mapFor = (origin: string, pathAndQuery: string): Promise<DecodedMap | undefined> => {
    const cached = maps.get(pathAndQuery)
    if (cached !== undefined) {
      maps.delete(pathAndQuery)
      maps.set(pathAndQuery, cached)
      return cached
    }
    const loading = load(origin, pathAndQuery).catch(() => undefined)
    maps.set(pathAndQuery, loading)
    while (maps.size > maxMaps) {
      const oldest = maps.keys().next().value
      if (oldest === undefined) break
      maps.delete(oldest)
    }
    return loading
  }

  /** The script's path on this server, when a frame names this server at all. */
  const ownPath = (url: string, origin: string): string | undefined => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    const own = new URL(origin)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    // `localhost:<port>` and `127.0.0.1:<port>` both reach this server; another port is another server.
    if (parsed.port !== own.port) return undefined
    const host = parsed.hostname
    if (
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "[::1]" &&
      !host.endsWith(".localhost")
    )
      return undefined
    // Scripts only: fetching a page URL (an inline script's frame) would render it, loaders and all.
    if (!SCRIPT_PATH.test(parsed.pathname)) return undefined
    return `${parsed.pathname}${parsed.search}`
  }

  return {
    async mapStack(stack) {
      const origin = options.origin()
      const lines = stack.split("\n")
      const out: string[] = []
      let frames = 0
      for (const line of lines) {
        const frame = parseFrame(line)
        if (frame === undefined) {
          // The message block (and engine noise between frames) stays as it was.
          if (frames === 0) out.push(line)
          continue
        }
        if (frames >= MAX_FRAMES) break
        frames += 1
        let location = `${frame.url}:${frame.line}:${frame.column}`
        const path = origin === undefined ? undefined : ownPath(frame.url, origin)
        if (origin !== undefined && path !== undefined) {
          const map = await mapFor(origin, path)
          const position =
            map === undefined ? undefined : lookup(map, frame.line - 1, frame.column - 1)
          if (position !== undefined && position.source !== "")
            location = `${position.source}:${position.line}:${position.column}`
        }
        out.push(
          frame.name === undefined ? `    at ${location}` : `    at ${frame.name} (${location})`,
        )
      }
      return out.join("\n")
    },
    clear() {
      maps.clear()
    },
  }
}
