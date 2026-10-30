import { describe, expect, test } from "bun:test"
import {
  cloudflareLoader,
  type ImageInputProps,
  type ImageProps,
  resolveImage,
  type StaticImageData,
} from "../src/index.ts"

const image: StaticImageData = {
  src: "/assets/hero.png",
  width: 1200,
  height: 800,
  variants: [
    { src: "/assets/hero-320.webp", width: 320, height: 213 },
    { src: "/assets/hero-640.webp", width: 640, height: 427 },
    { src: "/assets/hero-1200.webp", width: 1200, height: 800 },
  ],
}

describe("static images", () => {
  test("infer dimensions and use existing prebuilt variants", () => {
    expect(resolveImage({ src: image, alt: "Hero", sizes: "100vw" })).toMatchObject({
      src: "/assets/hero-1200.webp",
      width: 1200,
      height: 800,
      sizes: "100vw",
      srcSet:
        "/assets/hero-320.webp 320w, /assets/hero-640.webp 640w, /assets/hero-1200.webp 1200w",
    })
  })
  test("one overridden dimension preserves aspect ratio", () => {
    expect(resolveImage({ src: image, width: 600, alt: "" })).toMatchObject({
      width: 600,
      height: 400,
      src: "/assets/hero-640.webp",
    })
    expect(resolveImage({ src: image, height: 200, alt: "" })).toMatchObject({
      width: 300,
      height: 200,
      src: "/assets/hero-320.webp",
    })
    expect(resolveImage({ src: image, width: 60, height: 60, alt: "" })).toMatchObject({
      width: 60,
      height: 60,
    })
  })
  test("metadata-only assets need neither dimensions nor a codec", () => {
    expect(resolveImage({ src: { src: "/logo.png", width: 30, height: 20 }, alt: "Logo" })).toEqual(
      {
        src: "/logo.png",
        width: 30,
        height: 20,
        alt: "Logo",
        loading: "lazy",
        decoding: "async",
      },
    )
  })
  test("an explicit loader overrides the static variants", () => {
    const result = resolveImage(
      { src: image, alt: "", height: 200, widths: [600, 300], quality: 70 },
      cloudflareLoader(),
    )
    expect(result).toMatchObject({
      src: "/cdn-cgi/image/format=auto,width=300,quality=70/assets/hero.png",
      width: 300,
      height: 200,
      srcSet:
        "/cdn-cgi/image/format=auto,width=300,quality=70/assets/hero.png 300w, /cdn-cgi/image/format=auto,width=600,quality=70/assets/hero.png 600w",
    })
  })
  test("requested static widths pick real available variants and never upscale", () => {
    const result = resolveImage({ src: image, alt: "", widths: [400, 2000, 500] })
    expect(result.srcSet).toBe("/assets/hero-640.webp 640w, /assets/hero-1200.webp 1200w")
    expect(() => resolveImage({ src: image, alt: "", widths: [Number.NaN] })).toThrow(
      /positive finite/,
    )
  })
  test("invalid metadata cannot bypass the dimension guard even with explicit dimensions", () => {
    for (const dimension of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const invalid of [
        { ...image, width: dimension },
        { ...image, height: dimension },
      ]) {
        expect(() => resolveImage({ src: invalid, width: 100, height: 100, alt: "" })).toThrow(
          /intrinsic dimensions/,
        )
      }
      expect(() => resolveImage({ src: image, width: dimension, alt: "" })).toThrow(/CLS/)
      expect(() => resolveImage({ src: image, height: dimension, alt: "" })).toThrow(/CLS/)
    }
    expect(() => {
      // @ts-expect-error A JavaScript caller may pass null metadata; reject it before reading intrinsic dimensions.
      return resolveImage({ src: null, alt: "" })
    }).toThrow(/intrinsic dimensions/)
  })
  test("invalid variant dimensions are rejected before emitting a srcSet", () => {
    for (const dimension of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const variant of [
        { src: "/bad.webp", width: dimension, height: 20 },
        { src: "/bad.webp", width: 20, height: dimension },
      ]) {
        expect(() => resolveImage({ src: { ...image, variants: [variant] }, alt: "" })).toThrow(
          /variants require positive dimensions/,
        )
      }
    }
  })
  test("empty requested widths omit srcSet but retain the nearest real fallback", () => {
    const result = resolveImage({ src: image, alt: "", width: 500, widths: [] })
    expect(result.src).toBe("/assets/hero-640.webp")
    expect(result).not.toHaveProperty("srcSet")
    expect(resolveImage({ src: { ...image, variants: [] }, alt: "", width: 300 }).src).toBe(
      image.src,
    )
  })
})

// Compile-time contracts: string URLs retain their dimensions and extendable interface.
const imported: ImageInputProps = { src: image, alt: "" }
// @ts-expect-error string sources still require explicit dimensions
const missing: ImageInputProps = { src: "/x.png", alt: "" }
void imported
void missing
interface ExtendedImage extends ImageProps {
  readonly trackingId: string
}
const extended: ExtendedImage = {
  src: "/x.png",
  width: 10,
  height: 20,
  alt: "",
  trackingId: "hero",
}
void extended
