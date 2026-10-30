/** Browser-safe output of an `?image` import. No filesystem or codec enters the client. */
export interface StaticImageVariant {
  readonly src: string
  readonly width: number
  readonly height: number
}

/** Intrinsic display dimensions (including EXIF orientation), plus optional prebuilt variants. */
export interface StaticImageData {
  readonly src: string
  readonly width: number
  readonly height: number
  readonly variants?: readonly StaticImageVariant[]
}

/** Choose existing widths only; a static image never invents a resize endpoint. */
export function staticImageSources(
  image: StaticImageData,
  width: number,
  widths?: readonly number[],
): { src: string; srcSet?: string } {
  const variants = [...(image.variants ?? [])].sort((a, b) => a.width - b.width)
  if (variants.length === 0) return { src: image.src }
  for (const variant of variants) {
    if (
      !Number.isFinite(variant.width) ||
      variant.width <= 0 ||
      !Number.isFinite(variant.height) ||
      variant.height <= 0
    ) {
      throw new Error("[nifra/image] static image variants require positive dimensions")
    }
  }
  const nearest = (requested: number): StaticImageVariant =>
    variants.find((variant) => variant.width >= requested) ?? variants[variants.length - 1]!
  const selected = widths === undefined ? variants : widths.map(nearest)
  const unique = [...new Map(selected.map((variant) => [variant.width, variant])).values()].sort(
    (a, b) => a.width - b.width,
  )
  return {
    src: nearest(width).src,
    ...(unique.length > 0
      ? { srcSet: unique.map((variant) => `${variant.src} ${variant.width}w`).join(", ") }
      : {}),
  }
}
