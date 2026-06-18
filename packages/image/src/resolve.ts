/**
 * The pure attribute builder shared by every adapter `<Image>` — turns image props into CLS-safe,
 * responsive `<img>` attributes (`src`/`srcSet`/`sizes`/`width`/`height`/`loading`/`decoding`/
 * `fetchpriority`). The actual resize is delegated to an {@link ImageLoader} (a URL builder) — nifra
 * bundles no codec; point the loader at your image CDN.
 */

import { signImageParams } from "./sign.ts"

/** Builds a variant URL for `src` at a target pixel `width` (and optional `quality`). */
export type ImageLoader = (args: { src: string; width: number; quality?: number }) => string

/** Default loader: return the source unchanged (no transform). Use when there's no image CDN — you
 * still get CLS-safe sizing + lazy loading, just no responsive variants. */
export const identityLoader: ImageLoader = ({ src }) => src

export interface CloudflareLoaderOptions {
  /** Prefix for the source (e.g. an absolute origin) when `src` is a bare path. Default: none. */
  readonly base?: string
}

/**
 * Cloudflare Images loader — builds `/cdn-cgi/image/<options>/<source>` URLs that the Cloudflare edge
 * resizes on the fly (also emits `format=auto` for webp/avif negotiation). Works on Cloudflare Pages /
 * Workers with Images enabled.
 */
export function cloudflareLoader(options: CloudflareLoaderOptions = {}): ImageLoader {
  const base = options.base ?? ""
  return ({ src, width, quality }) => {
    const params = `format=auto,width=${width}${quality !== undefined ? `,quality=${quality}` : ""}`
    const source = `${base}${src}`.replace(/^\//, "") // the leading slash is provided by the prefix below
    return `/cdn-cgi/image/${params}/${source}`
  }
}

export interface SelfHostedLoaderOptions {
  /** Path/URL where `createImageHandler` (`@nifrajs/image/server`) is mounted, e.g. `"/_image"`. */
  readonly endpoint: string
  /**
   * HMAC secret for **signed URLs**. When set, each URL gets a stable `&s=` signature and the handler
   * must be configured with the SAME `signing.secret` — it then rejects any unsigned/forged `(src, w, q)`,
   * shutting down resize-bombing. ⚠️ The signer holds the secret, so a loader created with it is
   * **server-only** — inject it like a session secret (from `env`), never import this config into a
   * route/client module. Signatures are stable (no expiry), so SSR-signed URLs hydrate + cache identically.
   */
  readonly secret?: string
}

/**
 * Loader for nifra's **self-hosted** resize endpoint (`createImageHandler` from `@nifrajs/image/server`,
 * backed by `Bun.Image`/sharp/WASM). Builds `<endpoint>?src=…&w=…[&q=…][&s=…]` (the endpoint negotiates
 * the output format). Pure + dependency-free. For runtimes without a native codec, pair the endpoint
 * with `wasmImageBackend`, or use the CDN `cloudflareLoader` instead.
 */
export function selfHostedLoader(options: SelfHostedLoaderOptions): ImageLoader {
  const { endpoint, secret } = options
  return ({ src, width, quality }) => {
    const w = String(width)
    const q = quality !== undefined ? String(quality) : undefined
    const params = new URLSearchParams({ src, w })
    if (q !== undefined) params.set("q", q)
    if (secret !== undefined) params.set("s", signImageParams(secret, { src, w, q }))
    return `${endpoint}?${params.toString()}`
  }
}

export interface SignImageUrlOptions {
  /** HMAC secret — must match the handler's `signing.secret`. */
  readonly secret: string
  /** Seconds until the URL expires (adds `&exp=`). Omit for a stable, cacheable-forever signed URL. */
  readonly expiresIn?: number
}

/**
 * Mint a **signed** self-hosted image URL on the server — for cases the (stable) `selfHostedLoader`
 * doesn't cover, chiefly **time-limited** access (`expiresIn`) to private images. Server-only (it holds
 * the secret). Pair with a passthrough loader, or use the signed string as a plain `src`.
 *
 * ```ts
 * const url = signImageUrl("/_image", { src: "/private/a.jpg", width: 800 }, { secret, expiresIn: 300 })
 * ```
 */
export function signImageUrl(
  endpoint: string,
  image: { src: string; width: number; quality?: number },
  options: SignImageUrlOptions,
): string {
  const w = String(image.width)
  const q = image.quality !== undefined ? String(image.quality) : undefined
  const exp =
    options.expiresIn !== undefined
      ? String(Math.floor(Date.now() / 1000) + options.expiresIn)
      : undefined
  const params = new URLSearchParams({ src: image.src, w })
  if (q !== undefined) params.set("q", q)
  if (exp !== undefined) params.set("exp", exp)
  params.set("s", signImageParams(options.secret, { src: image.src, w, q, exp }))
  return `${endpoint}?${params.toString()}`
}

export interface ImageProps {
  readonly src: string
  /** Intrinsic width (px) — **required**, reserves layout space (no CLS). */
  readonly width: number
  /** Intrinsic height (px) — **required** (no CLS). */
  readonly height: number
  /** Alt text — **required** for accessibility (use `alt=""` for decorative images). */
  readonly alt: string
  /** `sizes` attribute for responsive selection (e.g. `"(max-width: 600px) 100vw, 600px"`). */
  readonly sizes?: string
  /** Widths to generate `srcSet` entries for. Default: `[width, width*2]` (1×/2× retina). */
  readonly widths?: readonly number[]
  /** Quality passed to the loader. */
  readonly quality?: number
  /** `lazy` (default) or `eager`. `priority` overrides this to eager. */
  readonly loading?: "lazy" | "eager"
  /** Mark the LCP image: `loading="eager"` + `fetchpriority="high"`. */
  readonly priority?: boolean
}

export interface ResolvedImage {
  readonly src: string
  readonly srcSet?: string
  readonly sizes?: string
  readonly width: number
  readonly height: number
  readonly alt: string
  readonly loading: "lazy" | "eager"
  readonly decoding: "async"
  readonly fetchPriority?: "high"
}

/**
 * Resolve {@link ImageProps} + an {@link ImageLoader} into `<img>` attributes. CLS-safe (`width`/
 * `height` required + > 0, else a dev error), lazy + async-decoding by default, with a responsive
 * `srcSet` built from `widths` via the loader. If every width produces the same URL (e.g.
 * {@link identityLoader}), `srcSet` is omitted (it'd be redundant).
 */
export function resolveImage(
  props: ImageProps,
  loader: ImageLoader = identityLoader,
): ResolvedImage {
  if (
    !Number.isFinite(props.width) ||
    props.width <= 0 ||
    !Number.isFinite(props.height) ||
    props.height <= 0
  ) {
    throw new Error(
      `[nifra/image] <Image> requires positive width + height (got ${props.width}×${props.height}) — they reserve layout space to prevent CLS.`,
    )
  }
  const eager = props.priority === true || props.loading === "eager"
  const widths = [...new Set(props.widths ?? [props.width, props.width * 2])].sort((a, b) => a - b)

  // Build the loader args, omitting `quality` when unset (exactOptionalPropertyTypes: no `undefined`).
  const at = (w: number): string =>
    loader(
      props.quality === undefined
        ? { src: props.src, width: w }
        : { src: props.src, width: w, quality: props.quality },
    )
  const entries = widths.map((w) => ({ url: at(w), w }))
  const allSame = entries.every((e) => e.url === entries[0]?.url)
  const srcSet = allSame ? undefined : entries.map((e) => `${e.url} ${e.w}w`).join(", ")

  // `src` is the 1× (intrinsic-width) variant — the fallback for browsers ignoring srcSet.
  const base: ResolvedImage = {
    src: at(props.width),
    width: props.width,
    height: props.height,
    alt: props.alt,
    loading: eager ? "eager" : "lazy",
    decoding: "async",
    ...(srcSet !== undefined ? { srcSet } : {}),
    ...(props.sizes !== undefined ? { sizes: props.sizes } : {}),
    ...(props.priority === true ? { fetchPriority: "high" as const } : {}),
  }
  return base
}
