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
import {
  decodeMappings,
  inlineSourceMap,
  lookupPosition,
  type MappingLine,
  originalPosition,
  type RawSourceMap,
} from "./internal/source-map.ts"

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
// Lookup
// ---------------------------------------------------------------------------------------------------

export { decodeMappings } from "./internal/source-map.ts"

interface DecodedMap {
  readonly sources: readonly string[]
  readonly lines: readonly (MappingLine | undefined)[]
  readonly sourcesContent: readonly unknown[]
  /** Per source, the map its content carries inline (a plugin's compile map), read on first use. */
  readonly inner: Map<number, RawSourceMap | undefined>
}

/**
 * The source position for a 0-based generated line/column. When the source is a plugin's output that
 * carries its own map inline (a compiled `.svelte` or `.vue` file), that map is followed too: Bun's
 * bundler keeps the plugin's output as the source, not the file it compiled.
 */
function lookup(
  map: DecodedMap,
  line: number,
  column: number,
): { source: string; line: number; column: number } | undefined {
  const found = lookupPosition(map.lines, line, column)
  if (found === undefined) return undefined
  const source = map.sources[found.source]
  if (source === undefined) return undefined
  if (!map.inner.has(found.source)) {
    const content = map.sourcesContent[found.source]
    map.inner.set(found.source, typeof content === "string" ? inlineSourceMap(content) : undefined)
  }
  const inner = map.inner.get(found.source)
  const original =
    inner === undefined ? undefined : originalPosition(inner, found.line, found.column)
  return original === undefined
    ? { source, line: found.line, column: found.column }
    : { source, line: original.line, column: original.column }
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
      sourcesContent: Array.isArray(raw.sourcesContent) ? raw.sourcesContent : [],
      inner: new Map(),
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
