/**
 * Dependency-free Open Graph image generation.
 *
 * **The default SVG output does not work as a social card.** X, Facebook, LinkedIn, Slack, Discord
 * and iMessage all refuse `image/svg+xml` for `og:image` and render nothing - the link preview is
 * blank, and it is blank silently, which is the failure mode this package exists to prevent
 * elsewhere. Serving SVG is only useful where you control the consumer: an internal dashboard, a
 * docs thumbnail, a preview route you look at yourself.
 *
 * **For a card a crawler will actually render, pass `rasterizer`.** It receives the SVG and returns
 * PNG/JPEG/WebP bytes - a Satori + Resvg pair is the usual choice. Keeping it injected rather than
 * bundled is what keeps a WASM rasterizer out of `@nifrajs/image` and out of every browser bundle
 * that imports this package for something else.
 *
 * ```ts
 * import { ogImageResponse } from "@nifrajs/image/og"
 *
 * // Renders on X, Facebook, LinkedIn, Slack.
 * export const GET = (request: Request) =>
 *   ogImageResponse({ title: "Ship it", rasterizer: pngRasterizer }, request)
 * ```
 */

export interface OgImageRasterized {
  readonly bytes: Uint8Array
  readonly contentType: string
}

export type OgImageRasterizer = (svg: string) => OgImageRasterized | Promise<OgImageRasterized>

export interface OgImageOptions {
  readonly title: string
  readonly description?: string
  readonly eyebrow?: string
  readonly width?: number
  readonly height?: number
  readonly background?: string
  readonly foreground?: string
  readonly accent?: string
  /** Optional PNG/JPEG/WebP backend. Omit to serve the generated SVG. */
  readonly rasterizer?: OgImageRasterizer
  /** Browser/cache freshness in seconds. Default one year. */
  readonly cacheMaxAge?: number
  /** Maximum bytes accepted from an injected rasterizer. Default 10 MiB. */
  readonly maxBytes?: number
}

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 630
const DEFAULT_MAX_AGE = 31_536_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const COLOR = /^(?:#[0-9a-fA-F]{3,8}|[A-Za-z]{1,32})$/

function boundedText(
  value: string | undefined,
  name: string,
  max: number,
  required = false,
): string {
  if (value === undefined && !required) return ""
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`og image: ${name} must be a non-empty string of at most ${max} characters`)
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127)
      throw new TypeError(`og image: ${name} contains a control character`)
  }
  return value
}

function dimension(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 4096) {
    throw new RangeError(`og image: ${name} must be a safe integer between 1 and 4096`)
  }
  return resolved
}

function color(value: string | undefined, name: string, fallback: string): string {
  const resolved = value ?? fallback
  if (!COLOR.test(resolved)) throw new TypeError(`og image: ${name} must be a safe color token`)
  return resolved
}

function nonNegativeInteger(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`og image: ${name} must be a non-negative safe integer`)
  }
  return resolved
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function wrap(value: string, maxChars: number): string[] {
  if (value === "") return []
  const words = value.split(/\s+/)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (word.length > maxChars) {
      if (line !== "") {
        lines.push(line)
        line = ""
      }
      for (let index = 0; index < word.length; index += maxChars) {
        lines.push(word.slice(index, index + maxChars))
      }
      continue
    }
    const candidate = line === "" ? word : `${line} ${word}`
    if (candidate.length > maxChars && line !== "") {
      lines.push(line)
      line = word
    } else line = candidate
  }
  if (line !== "") lines.push(line)
  return lines
}

function textLines(
  lines: readonly string[],
  x: number,
  y: number,
  size: number,
  fill: string,
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * Math.round(size * 1.18)}" fill="${fill}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="700">${escapeXml(line)}</text>`,
    )
    .join("")
}

/** Render a bounded, deterministic SVG suitable for an `og:image` endpoint. */
export function renderOgImage(options: OgImageOptions): string {
  const width = dimension(options.width, "width", DEFAULT_WIDTH)
  const height = dimension(options.height, "height", DEFAULT_HEIGHT)
  const title = boundedText(options.title, "title", 240, true)
  const description = boundedText(options.description, "description", 480)
  const eyebrow = boundedText(options.eyebrow, "eyebrow", 64)
  const background = color(options.background, "background", "#101827")
  const foreground = color(options.foreground, "foreground", "#f8fafc")
  const accent = color(options.accent, "accent", "#6ee7b7")
  const titleLines = wrap(title, width >= 900 ? 32 : 24).slice(0, 6)
  const descriptionLines = wrap(description, width >= 900 ? 72 : 48).slice(0, 4)
  const titleY = eyebrow === "" ? Math.round(height * 0.43) : Math.round(height * 0.48)
  const descriptionY = titleY + titleLines.length * 58 + 28
  const eyebrowMarkup =
    eyebrow === ""
      ? ""
      : `<text x="84" y="112" fill="${accent}" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" letter-spacing="3">${escapeXml(eyebrow)}</text>`
  const descriptionMarkup = textLines(descriptionLines, 84, descriptionY, 24, foreground)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}"><rect width="${width}" height="${height}" fill="${background}"/><rect x="84" y="${height - 70}" width="180" height="8" rx="4" fill="${accent}"/>${eyebrowMarkup}${textLines(titleLines, 84, titleY, 52, foreground)}${descriptionMarkup}</svg>`
}

function fnv1a(value: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value[index]!
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function ifNoneMatch(request: Request | undefined, etag: string): boolean {
  const value = request?.headers.get("if-none-match")
  if (value === null || value === undefined) return false
  return value.trim() === "*" || value.split(",").some((candidate) => candidate.trim() === etag)
}

function contentType(value: string): string {
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)) {
    throw new TypeError("og image: rasterizer content type must be a media type")
  }
  return value
}

/**
 * Build a cacheable OG image response. GET and HEAD are supported; conditional requests short-circuit
 * rasterization, so a crawler revalidation never repeats expensive codec work.
 */
export async function ogImageResponse(
  options: OgImageOptions,
  request?: Request,
): Promise<Response> {
  if (request !== undefined && request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } })
  }
  const cacheMaxAge = nonNegativeInteger(options.cacheMaxAge, "cacheMaxAge", DEFAULT_MAX_AGE)
  const maxBytes = nonNegativeInteger(options.maxBytes, "maxBytes", DEFAULT_MAX_BYTES)
  const svg = renderOgImage(options)
  let bytes: Uint8Array
  let mediaType = "image/svg+xml"
  try {
    if (options.rasterizer === undefined) bytes = new TextEncoder().encode(svg)
    else {
      const rasterized = await options.rasterizer(svg)
      if (!(rasterized.bytes instanceof Uint8Array) || rasterized.bytes.byteLength > maxBytes) {
        throw new TypeError("og image: rasterizer output exceeds maxBytes")
      }
      bytes = rasterized.bytes
      mediaType = contentType(rasterized.contentType)
    }
  } catch {
    return Response.json({ error: "image_generation_failed" }, { status: 500 })
  }
  // Hash the bytes actually sent. A rasterizer may produce different pixels for the same SVG
  // (for example after a backend/font update), so hashing only the source would make a conditional
  // request incorrectly return 304 for a changed representation.
  const etag = `"${fnv1a(bytes)}"`
  const headers = new Headers({
    "cache-control": `public, max-age=${cacheMaxAge}, immutable`,
    "content-type": `${mediaType}${mediaType === "image/svg+xml" ? "; charset=utf-8" : ""}`,
    etag,
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
  })
  if (ifNoneMatch(request, etag)) return new Response(null, { status: 304, headers })
  if (request?.method === "HEAD") return new Response(null, { status: 200, headers })
  return new Response(bytes, { status: 200, headers })
}
