import type { ImageLoader, ImageProps } from "@nifrajs/image"
import type { Component } from "svelte"
import type { HTMLImgAttributes } from "svelte/elements"

/**
 * Hand-written types for `Image.svelte` (svelte-package would generate this). The internal build
 * resolves `*.svelte` via the ambient `svelte-shim.d.ts`; this file is what *consumers* resolve through
 * the `./image` export's `types` condition.
 */
type ComputedAttrs =
  | "src"
  | "srcset"
  | "sizes"
  | "width"
  | "height"
  | "alt"
  | "loading"
  | "decoding"
  | "fetchpriority"

export interface ImageComponentProps
  extends ImageProps,
    Omit<HTMLImgAttributes, ComputedAttrs | keyof ImageProps> {
  /** CDN URL builder. Defaults to the identity loader (no transform — still CLS-safe + lazy). */
  loader?: ImageLoader
}

declare const Image: Component<ImageComponentProps>
export default Image
