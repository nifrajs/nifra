/**
 * `@nifrajs/web-solid/image` - a CLS-safe responsive Solid `<Image>`. A thin wrapper over `resolveImage`
 * from `@nifrajs/image`: it computes the responsive `<img>` attributes (`src`/`srcset`/`sizes`/`width`/
 * `height`/`loading`/`decoding`/`fetchpriority` via `toHtmlAttrs`) and renders an `<img>` through
 * Solid's `<Dynamic>`. Extra DOM props (`class`, `style`, `id`, `data-*`, handlers) pass through
 * reactively (`splitProps`/`mergeProps`). Resizing is delegated to the `loader`; nifra bundles no codec.
 * No JSX (`createComponent`/`Dynamic`), so the package builds with plain `tsc`.
 */
import {
  type ImageInputProps,
  type ImageLoader,
  type ImageProps,
  resolveImage,
  type StaticImageProps,
  toHtmlAttrs,
} from "@nifrajs/image"
import { createComponent, type JSX, mergeProps, splitProps } from "solid-js"
import { Dynamic } from "solid-js/web"

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
    Omit<JSX.ImgHTMLAttributes<HTMLImageElement>, ComputedAttrs | keyof ImageProps> {
  /** CDN URL builder. Defaults to the identity loader (no transform - still CLS-safe + lazy). */
  readonly loader?: ImageLoader
}

export type StaticImageComponentProps = StaticImageProps &
  Omit<ImageComponentProps, "src" | "width" | "height">

/**
 * Render a responsive, CLS-safe `<img>`. String URLs require dimensions; asset imports infer them;
 * `priority` marks the LCP image (`eager` + `fetchpriority="high"`). Extra DOM props pass through.
 */
export function Image(props: ImageComponentProps | StaticImageComponentProps): JSX.Element {
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
    const common = {
      alt: props.alt,
      ...(props.sizes !== undefined ? { sizes: props.sizes } : {}),
      ...(props.widths !== undefined ? { widths: props.widths } : {}),
      ...(props.quality !== undefined ? { quality: props.quality } : {}),
      ...(props.loading !== undefined ? { loading: props.loading } : {}),
      ...(props.priority !== undefined ? { priority: props.priority } : {}),
    }
    const input: ImageInputProps =
      typeof props.src === "string"
        ? {
            ...common,
            src: props.src,
            width: props.width ?? Number.NaN,
            height: props.height ?? Number.NaN,
          }
        : {
            ...common,
            src: props.src,
            ...(props.width !== undefined ? { width: props.width } : {}),
            ...(props.height !== undefined ? { height: props.height } : {}),
          }
    return toHtmlAttrs(resolveImage(input, props.loader))
  }
  return createComponent(Dynamic, mergeProps(rest, attrs, { component: "img" }))
}
