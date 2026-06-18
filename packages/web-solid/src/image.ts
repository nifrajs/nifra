/**
 * `@nifrajs/web-solid/image` — a CLS-safe responsive Solid `<Image>`. A thin wrapper over `resolveImage`
 * from `@nifrajs/image`: it computes the responsive `<img>` attributes (`src`/`srcset`/`sizes`/`width`/
 * `height`/`loading`/`decoding`/`fetchpriority` via `toHtmlAttrs`) and renders an `<img>` through
 * Solid's `<Dynamic>`. Extra DOM props (`class`, `style`, `id`, `data-*`, handlers) pass through
 * reactively (`splitProps`/`mergeProps`). Resizing is delegated to the `loader`; nifra bundles no codec.
 * No JSX (`createComponent`/`Dynamic`), so the package builds with plain `tsc`.
 */
import { type ImageLoader, type ImageProps, resolveImage, toHtmlAttrs } from "@nifrajs/image"
import { createComponent, type JSX, mergeProps, splitProps } from "solid-js"
import { Dynamic } from "solid-js/web"

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
    Omit<JSX.ImgHTMLAttributes<HTMLImageElement>, ComputedAttrs | keyof ImageProps> {
  /** CDN URL builder. Defaults to the identity loader (no transform — still CLS-safe + lazy). */
  readonly loader?: ImageLoader
}

/**
 * Render a responsive, CLS-safe `<img>`. `width`+`height` are required (reserve layout space);
 * `priority` marks the LCP image (`eager` + `fetchpriority="high"`). Extra DOM props pass through.
 */
export function Image(props: ImageComponentProps): JSX.Element {
  // Separate the nifra-only props (not valid DOM attributes) from the DOM passthrough (`rest`), keeping
  // both reactive. `rest` carries class/style/id/handlers; the computed attrs are layered over it.
  const [, rest] = splitProps(props, [
    "loader",
    "widths",
    "quality",
    "priority",
    "src",
    "width",
    "height",
    "alt",
    "sizes",
    "loading",
  ])
  const attrs = (): ReturnType<typeof toHtmlAttrs> => {
    // Build ImageProps via conditional spreads (exactOptionalPropertyTypes: an unset optional is
    // absent, not `undefined`). resolveImage validates width/height > 0 (CLS contract).
    const input: ImageProps = {
      src: props.src,
      width: props.width,
      height: props.height,
      alt: props.alt,
      ...(props.sizes !== undefined ? { sizes: props.sizes } : {}),
      ...(props.widths !== undefined ? { widths: props.widths } : {}),
      ...(props.quality !== undefined ? { quality: props.quality } : {}),
      ...(props.loading !== undefined ? { loading: props.loading } : {}),
      ...(props.priority !== undefined ? { priority: props.priority } : {}),
    }
    return toHtmlAttrs(resolveImage(input, props.loader))
  }
  return createComponent(Dynamic, mergeProps(rest, attrs, { component: "img" }))
}
