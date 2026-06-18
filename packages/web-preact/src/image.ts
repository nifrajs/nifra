/**
 * `@nifrajs/web-preact/image` — a CLS-safe responsive Preact `<Image>`. A thin wrapper over `resolveImage`
 * from `@nifrajs/image`: it computes the responsive `<img>` attributes (`src`/`srcset`/`sizes`/`width`/
 * `height`/`loading`/`decoding`/`fetchpriority` — Preact uses lowercase HTML attribute names, so it
 * spreads `toHtmlAttrs`) and forwards any extra DOM props (`class`, `style`, `id`, `data-*`, handlers).
 * Resizing is delegated to the `loader` (an image CDN); nifra bundles no codec. No JSX (`h`).
 */
import { type ImageLoader, type ImageProps, resolveImage, toHtmlAttrs } from "@nifrajs/image"
import { h, type JSX, type VNode } from "preact"

/** Attributes `resolveImage` computes — callers can't override them via DOM passthrough. */
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
  /** CDN URL builder. Defaults to the identity loader (no transform — still CLS-safe + lazy). */
  readonly loader?: ImageLoader
}

/**
 * Render a responsive, CLS-safe `<img>`. `width`+`height` are required (reserve layout space);
 * `priority` marks the LCP image (`eager` + `fetchpriority="high"`). Extra DOM props pass through.
 */
export function Image(props: ImageComponentProps): VNode {
  // Strip the nifra-only props (not valid DOM attributes) before forwarding the rest to <img>.
  const { loader, widths, quality, priority, ...rest } = props
  const attrs = toHtmlAttrs(resolveImage(props, loader))
  // `attrs` wins over the raw src/width/height/alt/sizes/loading still present in `rest`. The typed
  // local pins Preact's `h` to its string-tag overload (spreads skip excess-property checks).
  const imgProps: JSX.IntrinsicElements["img"] = { ...rest, ...attrs }
  return h("img", imgProps)
}
