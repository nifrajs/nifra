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
    expect(resolveImage({ src: image, alt: "", width: 300 }, cloudflareLoader()).src).toBe(
      "/cdn-cgi/image/format=auto,width=300/assets/hero.png",
    )
  })
  test("requested static widths pick real available variants and never upscale", () => {
    const result = resolveImage({ src: image, alt: "", widths: [400, 2000, 500] })
    expect(result.srcSet).toBe("/assets/hero-640.webp 640w, /assets/hero-1200.webp 1200w")
    expect(() => resolveImage({ src: image, alt: "", widths: [Number.NaN] })).toThrow(
      /positive finite/,
    )
  })
  test("invalid metadata cannot bypass the dimension guard", () => {
    expect(() => resolveImage({ src: { src: "/x", width: 0, height: 20 }, alt: "" })).toThrow(
      /intrinsic dimensions/,
    )
    expect(() => resolveImage({ src: image, width: 0, alt: "" })).toThrow(/CLS/)
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
