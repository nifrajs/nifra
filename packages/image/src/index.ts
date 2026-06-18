/**
 * `@nifrajs/image` — image optimization for nifra. A CLS-safe responsive `<Image>` (per-adapter) built on
 * the pure attribute builder `resolveImage`, pluggable CDN `ImageLoader`s (Cloudflare Images + an
 * identity default), and dependency-free intrinsic-dimension reading. nifra bundles no image codec; the
 * resize is delegated to the edge CDN via the loader. Per-adapter `<Image>` lives in the adapter packages.
 */
export {
  type ImageFormat,
  type ImageInfo,
  imageDimensions,
  readImageDimensions,
} from "./dimensions.ts"
export { type HtmlImageAttrs, toHtmlAttrs } from "./html.ts"
export {
  type CloudflareLoaderOptions,
  cloudflareLoader,
  type ImageLoader,
  type ImageProps,
  identityLoader,
  type ResolvedImage,
  resolveImage,
  type SelfHostedLoaderOptions,
  type SignImageUrlOptions,
  selfHostedLoader,
  signImageUrl,
} from "./resolve.ts"
