/**
 * The pure attribute builder shared by every adapter `<Image>` - turns image props into CLS-safe,
 * responsive `<img>` attributes (`src`/`srcSet`/`sizes`/`width`/`height`/`loading`/`decoding`/
 * `fetchpriority`). The actual resize is delegated to an {@link ImageLoader} (a URL builder) - nifra
 * bundles no codec; point the loader at your image CDN.
 */

import { signImageParams } from "./sign.ts"
import { type StaticImageData, staticImageSources } from "./static.ts"

/** Builds a variant URL for `src` at a target pixel `width` (and optional `quality`). */
export type ImageLoader = (args: { src: string; width: number; quality?: number }) => string

/** Default loader: return the source unchanged (no transform). Use when there's no image CDN - you
 * still get CLS-safe sizing + lazy loading, just no responsive variants. */
export const identityLoader: ImageLoader = ({ src }) => src

export interface CloudflareLoaderOptions {
  /** Prefix for the source (e.g. an absolute origin) when `src` is a bare path. Default: none. */
  readonly base?: string
}

/**
 * Cloudflare Images loader - builds `/cdn-cgi/image/<options>/<source>` URLs that the Cloudflare edge
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
   * must be configured with the SAME `signing.secret` - it then rejects any unsigned/forged `(src, w, q)`,
   * shutting down resize-bombing. ⚠️ The signer holds the secret, so a loader created with it is
   * **server-only** - inject it like a session secret (from `env`) in backend code, never a page or
   * `frontend/` module. Signatures are stable (no expiry), so SSR-signed URLs hydrate + cache identically.
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
  /** HMAC secret - must match the handler's `signing.secret`. */
  readonly secret: string
  /** Seconds until the URL expires (adds `&exp=`). Omit for a stable, cacheable-forever signed URL. */
  readonly expiresIn?: number
}

/**
 * Mint a **signed** self-hosted image URL on the server - for cases the (stable) `selfHostedLoader`
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

/** String URLs retain the original, extendable props contract. */
export interface ImageProps extends ImagePresentationProps {
  readonly src: string
  readonly width: number
  readonly height: number
}

export interface StaticImageProps extends ImagePresentationProps {
  readonly src: StaticImageData
  readonly width?: number
  readonly height?: number
}

export type ImageInputProps = ImageProps | StaticImageProps

export interface ImagePresentationProps {
  /** Alt text - **required** for accessibility (use `alt=""` for decorative images). */
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
 * Resolve a URL or imported asset into CLS-safe attributes. Explicit dimensions override imported
 * metadata; supplying just one scales the other to preserve the source's aspect ratio. Prebuilt
 * variants need no runtime loader. An explicit CDN loader takes precedence over those variants.
 */
export function resolveImage(
  props: ImageInputProps,
  loader: ImageLoader = identityLoader,
): ResolvedImage {
  const image = typeof props.src === "string" ? undefined : props.src
  if (
    image !== undefined &&
    (!image ||
      !Number.isFinite(image.width) ||
      image.width <= 0 ||
      !Number.isFinite(image.height) ||
      image.height <= 0)
  ) {
    throw new Error("[nifra/image] imported image requires positive intrinsic dimensions")
  }
  const width =
    props.width ??
    (image && props.height !== undefined
      ? (props.height * image.width) / image.height
      : image?.width) ??
    Number.NaN
  const height =
    props.height ??
    (image && props.width !== undefined
      ? (props.width * image.height) / image.width
      : image?.height) ??
    Number.NaN
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(
      `[nifra/image] <Image> requires positive width + height (got ${width}×${height}) - they reserve layout space to prevent CLS.`,
    )
  }
  const eager = props.priority === true || props.loading === "eager"
  if (props.widths?.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("[nifra/image] responsive widths must be positive finite numbers")
  }
  const source = typeof props.src === "string" ? props.src : props.src.src
  const widths = [...new Set(props.widths ?? [width, width * 2])].sort((a, b) => a - b)
  const at = (w: number): string =>
    loader(
      props.quality === undefined
        ? { src: source, width: w }
        : { src: source, width: w, quality: props.quality },
    )
  const entries = widths.map((w) => ({ url: at(w), w }))
  const allSame = entries.every((entry) => entry.url === entries[0]?.url)
  const srcSet = allSame ? undefined : entries.map((entry) => `${entry.url} ${entry.w}w`).join(", ")
  const sources =
    image !== undefined && loader === identityLoader
      ? staticImageSources(image, width, props.widths)
      : { src: at(width), ...(srcSet !== undefined ? { srcSet } : {}) }
  const base: ResolvedImage = {
    ...sources,
    width,
    height,
    alt: props.alt,
    loading: eager ? "eager" : "lazy",
    decoding: "async",
    ...(props.sizes !== undefined ? { sizes: props.sizes } : {}),
    ...(props.priority === true ? { fetchPriority: "high" as const } : {}),
  }
  return base
}
