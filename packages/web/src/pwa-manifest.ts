/**
 * `@nifrajs/web/pwa-manifest` - a Web App Manifest builder, the declarative half of PWA next to
 * `@nifrajs/web/service-worker`'s generated worker. Pure + runtime-agnostic: describe the app and
 * get the `manifest.json` bytes to serve (typically `app.get("/manifest.webmanifest", ...)` with
 * `content-type: application/manifest+json`), plus the `<link rel="manifest">` tag for the
 * document head. Follows the [Web App Manifest spec](https://www.w3.org/TR/appmanifest/) field
 * names exactly, so MDN is the reference for anything not documented here.
 *
 * Invalid input throws loudly at build/startup time (a missing install name, a malformed icon
 * size, an unknown display mode) - a manifest the browser silently ignores is worse than no
 * manifest, and these are all developer mistakes, never request input.
 */

export type ManifestDisplay = "fullscreen" | "standalone" | "minimal-ui" | "browser"
export type ManifestDir = "ltr" | "rtl" | "auto"
export type ManifestPurpose = "any" | "maskable" | "monochrome"

export interface ManifestIcon {
  /** Icon URL, resolved relative to `start_url` by the browser when relative. */
  readonly src: string
  /** Space-separated sizes, e.g. `"192x192 512x512"`, or `"any"`. Default `"any"`. */
  readonly sizes?: string
  /** MIME type, e.g. `"image/png"`. */
  readonly type?: string
  /** Space-separated purposes. Default `"any"`. */
  readonly purpose?: string
}

export interface ManifestScreenshot {
  readonly src: string
  readonly sizes?: string
  readonly type?: string
}

export interface ManifestShortcut {
  readonly name: string
  readonly url: string
  readonly short_name?: string
  readonly description?: string
  readonly icons?: readonly ManifestIcon[]
}

export interface PwaManifestOptions {
  /** Full install name (`"Nifra News"`). One of `name` / `short_name` is required. */
  readonly name?: string
  /** Short install name for launchers (`"News"`). One of `name` / `short_name` is required. */
  readonly short_name?: string
  readonly description?: string
  /** Navigation scope root. Default `"/"`. */
  readonly start_url?: string
  /** URL scope the manifest (and its service worker) controls. Default `start_url`'s directory. */
  readonly scope?: string
  /** Preferred display mode. Default `"standalone"` (the installable PWA shape). */
  readonly display?: ManifestDisplay
  readonly orientation?: string
  readonly background_color?: string
  readonly theme_color?: string
  readonly lang?: string
  readonly dir?: ManifestDir
  /** Opaque id distinguishing this install (defaults to `start_url` per spec). */
  readonly id?: string
  readonly categories?: readonly string[]
  readonly icons?: readonly ManifestIcon[]
  readonly screenshots?: readonly ManifestScreenshot[]
  readonly shortcuts?: readonly ManifestShortcut[]
}

const SIZE_LIST = /^(?:any|\d+x\d+)(?:\s+(?:any|\d+x\d+))*$/
const PURPOSE_TOKENS: ReadonlySet<string> = new Set(["any", "maskable", "monochrome"])

/** The start URL's directory, origin-preserving for absolute URLs. Query strings and hashes
 * never belong to a scope - it is a URL prefix the browser matches against. */
function defaultScope(start_url: string): string {
  if (start_url.startsWith("/")) {
    const bare = start_url.split(/[?#]/)[0] as string
    return bare.endsWith("/") ? bare : bare.slice(0, bare.lastIndexOf("/") + 1)
  }
  let url: URL
  try {
    url = new URL(start_url)
  } catch {
    throw new Error(`pwaManifest: start_url ${JSON.stringify(start_url)} is not a path or URL`)
  }
  if (url.origin === "null") {
    throw new Error(`pwaManifest: start_url ${JSON.stringify(start_url)} is not a path or URL`)
  }
  const dir = url.pathname.endsWith("/")
    ? url.pathname
    : url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)
  return `${url.origin}${dir}`
}

function purposeOf(purpose: string | undefined, what: string): string | undefined {
  if (purpose === undefined) return undefined
  const tokens = purpose.split(/\s+/).filter((t) => t !== "")
  if (tokens.length === 0) throw new Error(`pwaManifest: ${what} purpose must not be empty`)
  for (const token of tokens) {
    if (!PURPOSE_TOKENS.has(token)) {
      throw new Error(
        `pwaManifest: ${what} purpose ${JSON.stringify(token)} must be any/maskable/monochrome`,
      )
    }
  }
  return tokens.join(" ")
}

/** Build the manifest document object (pass through `JSON.stringify` to serve it). */
export function pwaManifest(options: PwaManifestOptions): Record<string, unknown> {
  const { name, short_name } = options
  if (name === undefined && short_name === undefined) {
    throw new Error("pwaManifest: one of name / short_name is required")
  }
  const display = options.display ?? "standalone"
  if (
    display !== "fullscreen" &&
    display !== "minimal-ui" &&
    display !== "browser" &&
    display !== "standalone"
  ) {
    throw new Error(`pwaManifest: unknown display ${JSON.stringify(display)}`)
  }
  if (
    options.dir !== undefined &&
    options.dir !== "ltr" &&
    options.dir !== "rtl" &&
    options.dir !== "auto"
  ) {
    throw new Error(`pwaManifest: unknown dir ${JSON.stringify(options.dir)}`)
  }
  const start_url = options.start_url ?? "/"
  if (start_url === "") throw new Error("pwaManifest: start_url must not be empty")
  const manifest: Record<string, unknown> = {}
  if (name !== undefined) manifest.name = name
  if (short_name !== undefined) manifest.short_name = short_name
  if (options.description !== undefined) manifest.description = options.description
  manifest.start_url = start_url
  // The default scope is the start URL's directory ("https://x.com/app/home" → "…/app/"),
  // query/hash excluded; a same-origin absolute URL keeps its origin, a relative one stays
  // relative. Anything unparseable is a developer mistake, and fails loud.
  manifest.scope = options.scope ?? defaultScope(start_url)
  manifest.display = display
  if (options.orientation !== undefined) manifest.orientation = options.orientation
  if (options.background_color !== undefined) manifest.background_color = options.background_color
  if (options.theme_color !== undefined) manifest.theme_color = options.theme_color
  if (options.lang !== undefined) manifest.lang = options.lang
  if (options.dir !== undefined) manifest.dir = options.dir
  if (options.id !== undefined) manifest.id = options.id
  if (options.categories !== undefined) manifest.categories = [...options.categories]
  if (options.icons !== undefined) {
    manifest.icons = options.icons.map((icon, i) => {
      if (icon.src === "") throw new Error(`pwaManifest: icons[${i}].src must not be empty`)
      const sizes = icon.sizes ?? "any"
      if (!SIZE_LIST.test(sizes)) {
        throw new Error(
          `pwaManifest: icons[${i}].sizes ${JSON.stringify(icon.sizes)} must be "any" or space-separated WxH`,
        )
      }
      const entry: Record<string, unknown> = { src: icon.src, sizes }
      if (icon.type !== undefined) entry.type = icon.type
      const purpose = purposeOf(icon.purpose, `icons[${i}]`)
      if (purpose !== undefined) entry.purpose = purpose
      return entry
    })
  }
  if (options.screenshots !== undefined) {
    manifest.screenshots = options.screenshots.map((shot, i) => {
      if (shot.src === "") throw new Error(`pwaManifest: screenshots[${i}].src must not be empty`)
      const entry: Record<string, unknown> = { src: shot.src }
      if (shot.sizes !== undefined) {
        if (!SIZE_LIST.test(shot.sizes)) {
          throw new Error(
            `pwaManifest: screenshots[${i}].sizes ${JSON.stringify(shot.sizes)} must be "any" or space-separated WxH`,
          )
        }
        entry.sizes = shot.sizes
      }
      if (shot.type !== undefined) entry.type = shot.type
      return entry
    })
  }
  if (options.shortcuts !== undefined) {
    manifest.shortcuts = options.shortcuts.map((cut, i) => {
      if (cut.name === "") throw new Error(`pwaManifest: shortcuts[${i}].name must not be empty`)
      if (cut.url === "") throw new Error(`pwaManifest: shortcuts[${i}].url must not be empty`)
      const entry: Record<string, unknown> = { name: cut.name, url: cut.url }
      if (cut.short_name !== undefined) entry.short_name = cut.short_name
      if (cut.description !== undefined) entry.description = cut.description
      if (cut.icons !== undefined) {
        entry.icons = cut.icons.map((icon, j) => {
          if (icon.src === "") {
            throw new Error(`pwaManifest: shortcuts[${i}].icons[${j}].src must not be empty`)
          }
          const sizes = icon.sizes ?? "any"
          if (!SIZE_LIST.test(sizes)) {
            throw new Error(
              `pwaManifest: shortcuts[${i}].icons[${j}].sizes must be "any" or space-separated WxH`,
            )
          }
          return { src: icon.src, sizes }
        })
      }
      return entry
    })
  }
  return manifest
}

/** Serialize a manifest document to servable JSON (stable key order, no whitespace). */
export function serializeManifest(manifest: Record<string, unknown>): string {
  return JSON.stringify(manifest)
}

/** The `<link rel="manifest">` tag for the document head. */
export function manifestLink(href = "/manifest.webmanifest"): string {
  if (href === "") throw new Error("manifestLink: href must not be empty")
  const quoted = href.replace(/"/g, "&quot;")
  return `<link rel="manifest" href="${quoted}">`
}
