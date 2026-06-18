/**
 * `@nifrajs/web-react/image` — a CLS-safe responsive React `<Image>`. A thin wrapper over
 * `resolveImage` from `@nifrajs/image`: it computes `src`/`srcSet`/`sizes`/`width`/`height`/`loading`/
 * `decoding`/`fetchpriority` and renders a plain `<img>`, forwarding any extra DOM props
 * (`className`, `style`, `id`, event handlers, `data-*`, …). Resizing is delegated to the `loader`
 * (an image CDN); nifra bundles no codec. Imports only `react` + `@nifrajs/image`; no JSX.
 */
import { type ImageLoader, type ImageProps, resolveImage } from "@nifrajs/image"
import { type ComponentPropsWithoutRef, createElement, type ReactElement } from "react"

/** Attributes `resolveImage` computes — callers can't override them via DOM passthrough. */
type ComputedAttrs =
  | "src"
  | "srcSet"
  | "sizes"
  | "width"
  | "height"
  | "alt"
  | "loading"
  | "decoding"
  | "fetchPriority"

export interface ImageComponentProps
  extends ImageProps,
    Omit<ComponentPropsWithoutRef<"img">, ComputedAttrs | keyof ImageProps> {
  /** CDN URL builder. Defaults to the identity loader (no transform — still CLS-safe + lazy). */
  readonly loader?: ImageLoader
  /** `data-*` attributes pass through to the `<img>` (React doesn't auto-allow these on a custom
   * component, so they're declared explicitly). */
  readonly [key: `data-${string}`]: string | number | boolean | undefined
}

/**
 * Render a responsive, CLS-safe `<img>`. `width`+`height` are required (reserve layout space);
 * `priority` marks the LCP image (`eager` + `fetchpriority="high"`). Extra DOM props pass through.
 */
export function Image(props: ImageComponentProps): ReactElement {
  // Strip the nifra-only props (not valid DOM attributes) before forwarding the rest to <img>.
  const { loader, widths, quality, priority, ...rest } = props
  const resolved = resolveImage(props, loader)
  // `resolved` wins over the raw src/width/height/alt/sizes/loading still present in `rest`.
  return createElement("img", { ...rest, ...resolved })
}
