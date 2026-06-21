/**
 * Font optimization primitives — generate a **CLS-safe `@font-face`** rule and the matching
 * **preload `<link>`** for a self-hosted font. The two fixes that matter most (the ones `next/font`
 * automates) are right here: `font-display: swap` (text paints immediately, no invisible-text FOIT)
 * plus a preload so the file downloads with the document, and optional metric overrides
 * (`size-adjust`/`ascent-override`/…) so swapping from the fallback to the web font doesn't shift layout.
 *
 * Self-host the file (drop a `.woff2` in your assets — never hotlink Google's CDN), then:
 *
 *   // fonts.css (imported by your app — the CSS pipeline bundles + links it)
 *   import { fontFace } from "@nifrajs/web"
 *   export default fontFace({ family: "Inter", src: [{ url: "/fonts/inter.woff2" }], weight: "100 900" })
 *
 *   // a root layout's meta — becomes a <link rel="preload" as="font"> in <head>
 *   export const meta = { link: [fontPreload({ href: "/fonts/inter.woff2" })] }
 */
import type { LinkDescriptor } from "./manifest.ts"

/** `font-display` strategy. `swap` (the default here) paints fallback text immediately, then swaps. */
export type FontDisplay = "auto" | "block" | "swap" | "fallback" | "optional"

export interface FontSource {
  /** URL of the self-hosted font file. */
  readonly url: string
  /** `format()` hint (`woff2`, `woff`, `truetype`, …). Inferred from the URL extension when omitted. */
  readonly format?: string
}

export interface FontFace {
  readonly family: string
  /** One or more sources (best format first; the browser picks the first it supports). */
  readonly src: readonly FontSource[]
  /** `400`, `"700"`, or a variable-font range like `"100 900"`. */
  readonly weight?: number | string
  readonly style?: "normal" | "italic" | "oblique"
  /** Defaults to `"swap"` (no flash of invisible text). */
  readonly display?: FontDisplay
  /** Restrict the glyphs this face covers, e.g. `"U+0000-00FF"` — lets the browser skip the download
   * for pages without those characters. */
  readonly unicodeRange?: string
  /** Metric overrides that eliminate layout shift when the fallback swaps to the web font (the
   * `next/font` technique). e.g. `sizeAdjust: "105%"`, `ascentOverride: "90%"`. */
  readonly sizeAdjust?: string
  readonly ascentOverride?: string
  readonly descentOverride?: string
  readonly lineGapOverride?: string
}

const FORMAT_BY_EXT: Readonly<Record<string, string>> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
  eot: "embedded-opentype",
  svg: "svg",
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
}

/** Lowercased file extension of a URL, ignoring any `?query`/`#hash`. */
function extOf(url: string): string {
  const clean = url.split(/[?#]/, 1)[0] ?? url
  const dot = clean.lastIndexOf(".")
  return dot === -1 ? "" : clean.slice(dot + 1).toLowerCase()
}

/** Escape a value placed inside a double-quoted CSS string (`font-family`, `url("…")`, `format("…")`):
 * neutralize the quote, the escape char, and newlines so a value can't break out of the declaration. */
function cssQuoted(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ")
}

/** Sanitize an **unquoted** CSS token value (`font-weight`, `unicode-range`, `size-adjust`, …): drop the
 * characters that could end the declaration or the rule and inject more CSS. */
function cssToken(value: string): string {
  return value
    .replace(/[;{}<>]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim()
}

/**
 * Build a single `@font-face` CSS rule. Defaults to `font-display: swap`; infers each source's
 * `format()` from its extension. All values are CSS-escaped, so a dynamic family/URL can't inject CSS.
 * Put the result in a stylesheet your app imports (nifra's CSS pipeline bundles + links it).
 */
export function fontFace(face: FontFace): string {
  if (face.src.length === 0) {
    throw new Error("fontFace: `src` needs at least one source")
  }
  const src = face.src
    .map((source) => {
      const format = source.format ?? FORMAT_BY_EXT[extOf(source.url)]
      const formatPart = format === undefined ? "" : ` format("${cssQuoted(format)}")`
      return `url("${cssQuoted(source.url)}")${formatPart}`
    })
    .join(", ")
  const declarations = [
    `font-family: "${cssQuoted(face.family)}"`,
    `src: ${src}`,
    `font-display: ${face.display ?? "swap"}`,
  ]
  if (face.weight !== undefined) declarations.push(`font-weight: ${cssToken(String(face.weight))}`)
  if (face.style !== undefined) declarations.push(`font-style: ${face.style}`)
  if (face.unicodeRange !== undefined)
    declarations.push(`unicode-range: ${cssToken(face.unicodeRange)}`)
  if (face.sizeAdjust !== undefined) declarations.push(`size-adjust: ${cssToken(face.sizeAdjust)}`)
  if (face.ascentOverride !== undefined)
    declarations.push(`ascent-override: ${cssToken(face.ascentOverride)}`)
  if (face.descentOverride !== undefined)
    declarations.push(`descent-override: ${cssToken(face.descentOverride)}`)
  if (face.lineGapOverride !== undefined)
    declarations.push(`line-gap-override: ${cssToken(face.lineGapOverride)}`)
  return `@font-face {\n  ${declarations.join(";\n  ")};\n}`
}

export interface FontPreloadInput {
  /** URL of the self-hosted font file to preload. */
  readonly href: string
  /** MIME type (`font/woff2`, …). Inferred from the extension when omitted. */
  readonly type?: string
  /** `crossorigin` mode — defaults to `"anonymous"`. Fonts are always fetched in CORS mode, and a
   * preload whose `crossorigin` doesn't match the actual fetch is **wasted** (downloaded twice), so
   * this is on by default. */
  readonly crossOrigin?: "anonymous" | "use-credentials"
}

/**
 * Build a font preload as a `<link>` attribute set for a route/layout's `meta.link` — nifra injects it
 * into `<head>` (`<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous">`). Values are
 * escaped at injection by the head renderer. Preloading the font file removes a render-blocking round
 * trip (the browser would otherwise discover the font only after parsing the CSS).
 */
export function fontPreload(input: FontPreloadInput): LinkDescriptor {
  const type = input.type ?? MIME_BY_EXT[extOf(input.href)]
  return {
    rel: "preload",
    as: "font",
    href: input.href,
    ...(type === undefined ? {} : { type }),
    crossorigin: input.crossOrigin ?? "anonymous",
  }
}
