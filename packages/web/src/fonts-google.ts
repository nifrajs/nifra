/**
 * Build-time Google Fonts automation — the `next/font/google` equivalent. At **build time** (never on
 * the request path) it: builds the Google Fonts CSS2 URL, downloads the stylesheet, parses the
 * `@font-face` rules, downloads each `.woff2`, content-hashes it, writes it next to your assets, and
 * hands back a **self-hosted** `@font-face` stylesheet + the matching `<link rel="preload">`s. The
 * result is identical to dropping the files in yourself and calling {@link fontFace} — no runtime CDN
 * hotlink, no layout shift, hashed filenames for immutable caching.
 *
 *   // fonts.build.ts — run once at build time (e.g. a prebuild step)
 *   import { loadGoogleFont } from "@nifrajs/web/fonts"
 *   const inter = await loadGoogleFont(
 *     { family: "Inter", weights: [400, 700], subsets: ["latin"] },
 *     { outDir: "public/fonts" },               // → public/fonts/inter-latin-normal-400-<hash>.woff2
 *   )
 *   await Bun.write("app/fonts.css", inter.css) // import this stylesheet from your app
 *   // inter.preloads → spread into a root layout's `meta.link`
 *
 * Security: this fetches remote content and writes it to disk, so every input is validated and the
 * font-file host is **allowlisted to `fonts.gstatic.com` over https** — a tampered/MITM'd stylesheet
 * cannot make the build fetch an arbitrary URL (SSRF) or write an attacker-chosen blob. Downloads are
 * size-capped. Filenames are derived only from validated tokens + a content hash (no path traversal).
 */

import { writeFile as fsWriteFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type FontDisplay, fontFace, fontPreload } from "./fonts.ts"

/** Options describing the Google font to fetch + self-host. */
export interface GoogleFontOptions {
  /** Family name exactly as Google lists it, e.g. `"Inter"`, `"Open Sans"`, `"Roboto Mono"`. */
  readonly family: string
  /** Weights to request — numbers (`400`), numeric strings, a variable range (`"100 900"`), or the
   * keywords `"normal"`/`"bold"`. Defaults to `[400]`. */
  readonly weights?: readonly (number | string)[]
  /** Styles to request. Defaults to `["normal"]`. */
  readonly styles?: readonly ("normal" | "italic")[]
  /** Keep only these named subsets (`"latin"`, `"latin-ext"`, `"cyrillic"`, …). Google returns every
   * subset it has as a separate `@font-face`; this filters to the ones you serve. Defaults to keeping
   * all returned subsets. Ignored when {@link text} is set (glyph subsetting supersedes it). */
  readonly subsets?: readonly string[]
  /** `font-display` strategy for the generated faces. Defaults to `"swap"`. */
  readonly display?: FontDisplay
  /** Glyph subsetting: request only the glyphs needed to render exactly this text (Google's `&text=`).
   * Ideal for a logo/heading font — produces one tiny file. */
  readonly text?: string
  /** CLS metric overrides forwarded to every generated `@font-face` (the layout-shift fix). */
  readonly sizeAdjust?: string
  readonly ascentOverride?: string
  readonly descentOverride?: string
  readonly lineGapOverride?: string
}

/** A single `@font-face` block parsed out of Google's stylesheet. */
export interface ParsedFontFace {
  readonly family: string
  readonly style: string
  readonly weight: string
  readonly subset: string
  readonly unicodeRange?: string
  readonly src: readonly { readonly url: string; readonly format?: string }[]
}

/** One downloaded + written font file. */
export interface FontAsset {
  /** The hashed filename written under `outDir` (no directory part). */
  readonly fileName: string
  /** The public URL the generated `@font-face`/preload reference (`${publicPath}/${fileName}`). */
  readonly href: string
  /** The original `fonts.gstatic.com` URL the bytes came from. */
  readonly sourceUrl: string
  readonly bytes: Uint8Array
  readonly subset: string
  readonly weight: string
  readonly style: string
}

export interface LoadGoogleFontResult {
  readonly family: string
  /** A self-hosted `@font-face` stylesheet (one rule per written file). Import it from your app. */
  readonly css: string
  /** Every file written to `outDir`. */
  readonly assets: readonly FontAsset[]
  /** `fontPreload()` link-attribute sets — spread the ones you want into a layout's `meta.link`.
   * Preloading *every* weight/subset is wasteful; usually preload just the primary subset + weight. */
  readonly preloads: readonly Record<string, string>[]
}

export interface LoadGoogleFontIO {
  /** Directory to write the hashed `.woff2` files into (created if missing). */
  readonly outDir: string
  /** URL prefix the files are served under. Defaults to `"/fonts"`. */
  readonly publicPath?: string
  /** Injectable `fetch` (defaults to the global). Tests pass a canned implementation. */
  readonly fetch?: typeof fetch
  /** Injectable writer (defaults to `node:fs`). Tests pass an in-memory sink. */
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<void>
  /** Per-file download cap in bytes. Defaults to 5 MB (real woff2 are well under 1 MB). */
  readonly maxBytesPerFile?: number
}

const CSS2_ENDPOINT = "https://fonts.googleapis.com/css2"

/** Only this host, only over https, may supply a font file we download + write to disk. The SSRF gate:
 * a tampered stylesheet listing any other `src: url(...)` is rejected, not fetched. */
const ALLOWED_FONT_HOSTS: ReadonlySet<string> = new Set(["fonts.gstatic.com"])

/** A modern desktop-Chrome UA so Google serves `woff2` (it falls back to bulky `ttf` for unknown UAs). */
const WOFF2_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const DEFAULT_MAX_FONT_BYTES = 5 * 1024 * 1024
const MAX_CSS_BYTES = 512 * 1024
const MAX_TEXT_LEN = 2048

const VALID_DISPLAY: ReadonlySet<string> = new Set([
  "auto",
  "block",
  "swap",
  "fallback",
  "optional",
])

/** `true` iff `raw` is an `https://fonts.gstatic.com/…` URL — the only host we'll download from. */
export function isAllowedFontUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === "https:" && ALLOWED_FONT_HOSTS.has(url.hostname)
}

/** Validate a family name (letters/digits/spaces only). It goes into both a URL and a filename, so a
 * strict allowlist closes injection + path-traversal at the source. */
function validateFamily(family: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ]{0,62}$/.test(family)) {
    throw new Error(
      `loadGoogleFont: invalid family ${JSON.stringify(family)} (letters, digits, and spaces only)`,
    )
  }
  return family
}

/** Normalize a weight to the token Google expects: `400`, `"700"`, `normal`→`400`, `bold`→`700`, or a
 * variable range `"100 900"`. Rejects anything else (these land in the request URL). */
function normalizeWeight(weight: number | string): string {
  if (typeof weight === "number") {
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
      throw new Error(`loadGoogleFont: invalid weight ${weight} (1–1000)`)
    }
    return String(weight)
  }
  const w = weight.trim()
  if (w === "normal") return "400"
  if (w === "bold") return "700"
  // A single numeric weight, or a variable range like "100 900".
  if (/^\d{1,4}$/.test(w) || /^\d{1,4} \d{1,4}$/.test(w)) return w
  throw new Error(`loadGoogleFont: invalid weight ${JSON.stringify(weight)}`)
}

function validateSubset(subset: string): string {
  if (!/^[a-z0-9-]{1,32}$/.test(subset)) {
    throw new Error(`loadGoogleFont: invalid subset ${JSON.stringify(subset)}`)
  }
  return subset
}

/** Build the Google Fonts CSS2 request URL. Pure + fully validated, so it's safe to feed a dynamic
 * family/weights/text. Exported for advanced callers who fetch + parse the stylesheet themselves. */
export function googleFontsCssUrl(options: GoogleFontOptions): string {
  const family = validateFamily(options.family)
  const styles = options.styles ?? ["normal"]
  for (const s of styles) {
    if (s !== "normal" && s !== "italic") {
      throw new Error(`loadGoogleFont: invalid style ${JSON.stringify(s)}`)
    }
  }
  const display = options.display ?? "swap"
  if (!VALID_DISPLAY.has(display)) {
    throw new Error(`loadGoogleFont: invalid display ${JSON.stringify(display)}`)
  }

  // De-dupe + sort weights numerically (variable ranges sort by their lower bound).
  const weights = [...new Set((options.weights ?? [400]).map(normalizeWeight))].sort(
    (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10),
  )
  const hasItalic = styles.includes("italic")
  const hasNormal = styles.includes("normal") || !hasItalic

  // CSS2 wants spaces in the family as `+`; the `:`, `@`, `,`, `;` axis syntax stays literal.
  const familyName = encodeURIComponent(family).replace(/%20/g, "+")
  let axis: string
  if (hasItalic) {
    // `ital,wght@` with tuples; all normal (ital=0) tuples must precede italic (ital=1).
    const tuples: string[] = []
    if (hasNormal) for (const w of weights) tuples.push(`0,${w}`)
    for (const w of weights) tuples.push(`1,${w}`)
    axis = `ital,wght@${tuples.join(";")}`
  } else {
    axis = `wght@${weights.join(";")}`
  }

  const params: string[] = [`family=${familyName}:${axis}`, `display=${display}`]
  if (options.text !== undefined) {
    if (options.text.length > MAX_TEXT_LEN) {
      throw new Error(`loadGoogleFont: text exceeds ${MAX_TEXT_LEN} chars`)
    }
    if (options.text.length > 0) params.push(`text=${encodeURIComponent(options.text)}`)
  }
  return `${CSS2_ENDPOINT}?${params.join("&")}`
}

const FACE_RE = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g
const SRC_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]+)\3\s*\))?/g

function declOf(body: string, prop: string): string | undefined {
  const m = body.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`, "i"))
  return m?.[1]?.trim()
}

/** Parse Google's stylesheet into structured faces, capturing the `/* subset *​/` label that precedes
 * each `@font-face`. Pure — exported so callers can run their own download/write pipeline. */
export function parseGoogleFontCss(css: string): ParsedFontFace[] {
  const faces: ParsedFontFace[] = []
  for (const match of css.matchAll(FACE_RE)) {
    const subset = (match[1] ?? "").trim() || "default"
    const body = match[2] ?? ""
    const familyRaw = declOf(body, "font-family")
    if (familyRaw === undefined) continue
    const family = familyRaw.replace(/^['"]|['"]$/g, "")
    const src: { url: string; format?: string }[] = []
    for (const s of body.matchAll(SRC_RE)) {
      const url = s[2]
      if (url === undefined) continue
      src.push(s[4] === undefined ? { url } : { url, format: s[4] })
    }
    if (src.length === 0) continue
    const unicodeRange = declOf(body, "unicode-range")
    faces.push({
      family,
      style: declOf(body, "font-style") ?? "normal",
      weight: declOf(body, "font-weight") ?? "400",
      subset,
      ...(unicodeRange === undefined ? {} : { unicodeRange }),
      src,
    })
  }
  return faces
}

/** First 16 hex chars of the SHA-256 of the bytes — a content hash for an immutable, cache-busting
 * filename. Web Crypto, so it runs identically on Bun/Node/edge build hosts. `Uint8Array<ArrayBuffer>`
 * (not the generic `ArrayBufferLike`) to satisfy WebCrypto's `BufferSource` under TS 5.7+ generics. */
async function contentHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  let hex = ""
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0")
  return hex.slice(0, 16)
}

/** Lowercase a validated token into a filename-safe slug. */
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/** Host of a URL for error messages — we never echo the full untrusted URL+path. */
const hostOf = (raw: string): string => {
  try {
    return new URL(raw).host
  } catch {
    return "<invalid-url>"
  }
}

/** Fetch with a hard byte ceiling. Checks the advertised `Content-Length` first (cheap reject), then
 * re-checks the materialized body (a lying header can't smuggle a larger payload past us). */
async function fetchBounded(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  headers?: Record<string, string>,
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetchImpl(url, headers ? { headers } : {})
  if (!res.ok) {
    throw new Error(`loadGoogleFont: fetch failed (${res.status}) from ${hostOf(url)}`)
  }
  const advertised = Number(res.headers.get("content-length"))
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new Error(`loadGoogleFont: response from ${hostOf(url)} exceeds ${maxBytes} bytes`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new Error(`loadGoogleFont: response from ${hostOf(url)} exceeds ${maxBytes} bytes`)
  }
  return bytes
}

const defaultWriteFile = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await fsWriteFile(path, bytes)
}

/**
 * Download a Google font, self-host it, and return a CLS-safe `@font-face` stylesheet + preloads.
 * See the module header for the full flow and security model. I/O (`fetch`, `writeFile`) is injectable
 * so this is unit-testable without the network.
 */
export async function loadGoogleFont(
  options: GoogleFontOptions,
  io: LoadGoogleFontIO,
): Promise<LoadGoogleFontResult> {
  const family = validateFamily(options.family)
  const fetchImpl = io.fetch ?? fetch
  const writeFile = io.writeFile ?? defaultWriteFile
  const publicPath = (io.publicPath ?? "/fonts").replace(/\/+$/, "")
  const maxBytes = io.maxBytesPerFile ?? DEFAULT_MAX_FONT_BYTES
  const wantedSubsets = options.subsets?.map(validateSubset)

  const cssUrl = googleFontsCssUrl(options)
  const cssBytes = await fetchBounded(fetchImpl, cssUrl, MAX_CSS_BYTES, { "user-agent": WOFF2_UA })
  const css = new TextDecoder().decode(cssBytes)

  let faces = parseGoogleFontCss(css)
  if (faces.length === 0) {
    throw new Error(
      `loadGoogleFont: Google returned no @font-face rules for ${JSON.stringify(family)}`,
    )
  }
  // Filter to requested named subsets — but only when not glyph-subsetting (text mode labels faces
  // `[0]`, `[1]`, … which carry no subset name).
  if (wantedSubsets && wantedSubsets.length > 0 && options.text === undefined) {
    faces = faces.filter((f) => wantedSubsets.includes(f.subset))
    if (faces.length === 0) {
      throw new Error(`loadGoogleFont: no faces for subsets [${wantedSubsets.join(", ")}]`)
    }
  }

  const assets: FontAsset[] = []
  const rules: string[] = []
  const preloads: Record<string, string>[] = []

  for (const face of faces) {
    // Prefer woff2; the CSS2 endpoint with a Chrome UA only ever returns woff2, but be defensive.
    const source = face.src.find((s) => s.format === "woff2") ?? face.src[0]
    if (!source) continue
    if (!isAllowedFontUrl(source.url)) {
      throw new Error(
        `loadGoogleFont: refusing to download a font from a non-Google host (${hostOf(source.url)}); ` +
          "the stylesheet may be tampered with",
      )
    }
    const bytes = await fetchBounded(fetchImpl, source.url, maxBytes)
    const hash = await contentHash(bytes)
    const style = face.style === "italic" ? "italic" : "normal"
    const fileName = `${slug(family)}-${slug(face.subset)}-${style}-${face.weight.replace(/\s+/g, "_")}-${hash}.woff2`
    const path = join(io.outDir, fileName)
    await writeFile(path, bytes)

    const href = `${publicPath}/${fileName}`
    assets.push({
      fileName,
      href,
      sourceUrl: source.url,
      bytes,
      subset: face.subset,
      weight: face.weight,
      style,
    })
    rules.push(
      fontFace({
        family,
        src: [{ url: href, format: "woff2" }],
        weight: face.weight,
        style,
        display: options.display ?? "swap",
        ...(face.unicodeRange === undefined ? {} : { unicodeRange: face.unicodeRange }),
        ...(options.sizeAdjust === undefined ? {} : { sizeAdjust: options.sizeAdjust }),
        ...(options.ascentOverride === undefined ? {} : { ascentOverride: options.ascentOverride }),
        ...(options.descentOverride === undefined
          ? {}
          : { descentOverride: options.descentOverride }),
        ...(options.lineGapOverride === undefined
          ? {}
          : { lineGapOverride: options.lineGapOverride }),
      }),
    )
    preloads.push(fontPreload({ href }))
  }

  if (assets.length === 0) {
    throw new Error(`loadGoogleFont: no downloadable woff2 sources for ${JSON.stringify(family)}`)
  }
  return { family, css: rules.join("\n\n"), assets, preloads }
}
