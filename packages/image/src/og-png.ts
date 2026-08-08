import type { OgImageRasterizer } from "./og.ts"

/** A dependency-free shape implemented by SVG→PNG codecs such as Resvg, Satori, or a WASM backend. */
export type PngRenderer = (svg: string) => Uint8Array | Promise<Uint8Array>

export interface ResvgRenderer {
  render(): { asPng(): Uint8Array | Promise<Uint8Array> }
}

export type ResvgConstructor = new (svg: string) => ResvgRenderer

/**
 * Adapt an injected SVG→PNG renderer to `ogImageResponse`.
 *
 * The renderer stays application-owned because codec/WASM choice is runtime-specific. For example:
 *
 * ```ts
 * import { Resvg } from "@resvg/resvg-js"
 * import { createPngRasterizer } from "@nifrajs/image/og-png"
 * const rasterizer = createPngRasterizer((svg) => new Resvg(svg).render().asPng())
 * ```
 *
 * This is the public reference adapter; the core package remains zero-dependency and keeps SVG as its
 * explicit default for callers that do not opt into a codec.
 */
export function createPngRasterizer(render: PngRenderer): OgImageRasterizer {
  return async (svg) => ({ bytes: await render(svg), contentType: "image/png" })
}

/** Reference adapter for Resvg-compatible constructors, without making the optional codec a dependency. */
export function createResvgRasterizer(Resvg: ResvgConstructor): OgImageRasterizer {
  return createPngRasterizer((svg) => new Resvg(svg).render().asPng())
}
