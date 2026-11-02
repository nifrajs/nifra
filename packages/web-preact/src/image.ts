/**
 * `@nifrajs/web-preact/image` - a CLS-safe responsive Preact `<Image>`. A thin wrapper over `resolveImage`
 * from `@nifrajs/image`: it computes the responsive `<img>` attributes (`src`/`srcset`/`sizes`/`width`/
 * `height`/`loading`/`decoding`/`fetchpriority` - Preact uses lowercase HTML attribute names, so it
 * spreads `toHtmlAttrs`) and forwards any extra DOM props (`class`, `style`, `id`, `data-*`, handlers).
 * Resizing is delegated to the `loader` (an image CDN); nifra bundles no codec. No JSX (`h`).
 */
import {
  type ImageLoader,
  type ImageProps,
  resolveImage,
  type StaticImageProps,
  toHtmlAttrs,
} from "@nifrajs/image"
import { h, type JSX, type VNode } from "preact"

/** Attributes `resolveImage` computes - callers can't override them via DOM passthrough. */
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
    Omit<JSX.IntrinsicElements["img"], ComputedAttrs | keyof ImageProps> {
  /** CDN URL builder. Defaults to the identity loader (no transform - still CLS-safe + lazy). */
  readonly loader?: ImageLoader
}

export type StaticImageComponentProps = StaticImageProps &
  Omit<ImageComponentProps, "src" | "width" | "height">

/**
 * Render a responsive, CLS-safe `<img>`. String URLs require dimensions; asset imports infer them;
 * `priority` marks the LCP image (`eager` + `fetchpriority="high"`). Extra DOM props pass through.
 */
export function Image(props: ImageComponentProps | StaticImageComponentProps): VNode {
  // Strip the nifra-only props (not valid DOM attributes) before forwarding the rest to <img>.
  const { loader, widths, quality, priority, ...rest } = props
  const attrs = toHtmlAttrs(resolveImage(props, loader))
  // Normalize the VNode generic across Preact 10 and 11; the wrapper already types the DOM props.
  const imgProps = { ...rest, ...attrs }
  return h<Record<string, unknown>>("img", imgProps)
}
