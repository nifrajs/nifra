import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { sharpImageBackend } from "../src/backend.ts"
import { createImageAssets } from "../src/build.ts"
import { imageDimensions } from "../src/dimensions.ts"
import { imageBunPlugin, imageVitePlugin } from "../src/plugins.ts"

let root: string
let source: Uint8Array
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nifra-image-assets-"))
  source = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#df5123" } })
    .png()
    .toBuffer()
  writeFileSync(join(root, "hero.png"), source)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("image build assets", () => {
  test("reads intrinsic dimensions with no codec and emits content-hashed bytes", async () => {
    const images = createImageAssets({ root })
    const data = await images.load("hero.png")
    expect(data).toMatchObject({ width: 100, height: 50 })
    expect(data.src).toMatch(/^\/assets\/_images\/[0-9a-f]{64}\.png$/)
    expect(data.variants).toBeUndefined()
    expect(images.assets()).toHaveLength(1)
    expect(images.assets()[0]?.source).toEqual(source)
    expect(await images.load("hero.png")).toEqual(data)
    expect(images.assets()).toHaveLength(1)
  })

  test("generates real WebP variants, clamps and deduplicates without upscaling", async () => {
    const images = createImageAssets({
      root,
      widths: [50, 25, 50, 200],
      backend: sharpImageBackend((bytes) => sharp(Buffer.from(bytes))),
    })
    const data = await images.load("hero.png")
    expect(data.variants?.map((variant) => variant.width)).toEqual([25, 50, 100])
    expect(images.assets()).toHaveLength(4)
    for (const variant of data.variants ?? []) {
      const file = images.assets().find((asset) => `/assets/${asset.fileName}` === variant.src)
      expect(file).toBeDefined()
      expect(imageDimensions(file!.source)).toMatchObject({
        width: variant.width,
        height: variant.height,
        format: "webp",
      })
    }
  })

  test("output is independent of input filename and changes after source edits", async () => {
    writeFileSync(join(root, "other.png"), source)
    const images = createImageAssets({ root })
    const first = await images.load("hero.png")
    expect(await images.load("other.png")).toEqual(first)
    expect(images.assets()).toHaveLength(1)
    const changed = await sharp({
      create: { width: 80, height: 40, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer()
    writeFileSync(join(root, "hero.png"), changed)
    const next = await images.load("hero.png")
    expect(next.src).not.toBe(first.src)
    expect(next.width).toBe(80)
  })

  test("respects EXIF display orientation", async () => {
    const jpeg = await sharp(source).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    writeFileSync(join(root, "turned.jpg"), jpeg)
    expect(await createImageAssets({ root }).load("turned.jpg")).toMatchObject({
      width: 50,
      height: 100,
    })
  })

  test("PNG and WebP EXIF orientation agrees with auto-rotated real variants", async () => {
    for (const format of ["png", "webp"] as const) {
      const bytes = await sharp(source).toFormat(format).withMetadata({ orientation: 6 }).toBuffer()
      const file = `turned.${format}`
      writeFileSync(join(root, file), bytes)
      expect(await createImageAssets({ root }).load(file)).toMatchObject({ width: 50, height: 100 })
      const images = createImageAssets({
        root,
        widths: [25, 100],
        backend: sharpImageBackend((bytes) => sharp(Buffer.from(bytes))),
      })
      const data = await images.load(file)
      expect(data.variants?.map(({ width, height }) => [width, height])).toEqual([
        [25, 50],
        [50, 100],
      ])
    }
  })

  test("APNG animation control rejects variants before running a codec, but keeps metadata imports", async () => {
    // acTL immediately after IHDR: the animation guard must inspect chunks, not the PNG extension.
    const chunk = new Uint8Array(20)
    new DataView(chunk.buffer).setUint32(0, 8)
    chunk.set([0x61, 0x63, 0x54, 0x4c], 4)
    new DataView(chunk.buffer).setUint32(8, 2)
    const bytes = new Uint8Array([...source.subarray(0, 33), ...chunk, ...source.subarray(33)])
    writeFileSync(join(root, "animated.png"), bytes)
    expect(await createImageAssets({ root }).load("animated.png")).toMatchObject({
      width: 100,
      height: 50,
    })
    const backend = sharpImageBackend((bytes) => sharp(Buffer.from(bytes)))
    await expect(
      createImageAssets({ root, widths: [50], backend }).load("animated.png"),
    ).rejects.toThrow(/animated image variants/)
  })

  test("refuses source escapes, symlink escapes, non-images and configured caps", async () => {
    const outside = mkdtempSync(join(tmpdir(), "nifra-image-outside-"))
    try {
      const file = join(outside, "private.png")
      writeFileSync(file, source)
      symlinkSync(file, join(root, "link.png"))
      await expect(createImageAssets({ root }).load(file)).rejects.toThrow(/escapes/)
      await expect(createImageAssets({ root }).load("link.png")).rejects.toThrow(/escapes/)
      writeFileSync(join(root, "fake.png"), "not an image")
      await expect(createImageAssets({ root }).load("fake.png")).rejects.toThrow(/supported PNG/)
      await expect(
        createImageAssets({ root, maxSourceBytes: 10 }).load("hero.png"),
      ).rejects.toThrow(/maxSourceBytes/)
      await expect(
        createImageAssets({ root, maxSourcePixels: 100 }).load("hero.png"),
      ).rejects.toThrow(/maxSourcePixels/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("rejects invalid options before processing", () => {
    expect(() => createImageAssets({ widths: [50] })).toThrow(/explicit image backend/)
    for (const width of [0, -1, Number.NaN, 1.5, 8193]) {
      expect(() => createImageAssets({ widths: [width] })).toThrow(/width/)
    }
    expect(() => createImageAssets({ quality: 101 })).toThrow(/quality/)
    expect(() => createImageAssets({ maxSourceBytes: 0 })).toThrow(/maxSourceBytes/)
    for (const publicPath of ["//evil.test/", "assets", "/assets/../", "/x?y", "/x#y", "/%2e/"]) {
      expect(() => createImageAssets({ publicPath })).toThrow(/publicPath/)
    }
  })

  test("Bun imports metadata as a plain JS module, not binary or filesystem code", async () => {
    const entry = join(root, "entry.ts")
    writeFileSync(entry, 'import hero from "./hero.png?image"; console.log(hero)')
    const plugin = imageBunPlugin({ root })
    const result = await Bun.build({ entrypoints: [entry], target: "browser", plugins: [plugin] })
    expect(result.success).toBe(true)
    const text = await result.outputs[0]!.text()
    expect(text).toContain('"/assets/_images/')
    expect(text).not.toContain("node:fs")
    expect(plugin.nifraStaticAssets()).toHaveLength(1)
  })

  test("Vite uses the same metadata and exposes a watch dependency", async () => {
    const plugin = imageVitePlugin({ root })
    const watched: string[] = []
    const text = await plugin.load.call(
      {
        addWatchFile: (file) => {
          watched.push(file)
        },
      },
      join(root, "hero.png?image"),
    )
    expect(text).toContain('"width":100')
    expect(watched).toEqual([join(root, "hero.png")])
    expect(plugin.nifraStaticAssets()).toHaveLength(1)
    expect(await plugin.load.call({ addWatchFile() {} }, join(root, "hero.png"))).toBeUndefined()
  })
})

test("Vite dev middleware serves GET/HEAD and loads changed sources", async () => {
  const plugin = imageVitePlugin({ root })
  let serve:
    | ((
        req: { url?: string; method?: string },
        res: { setHeader(name: string, value: string): unknown; end(data?: Uint8Array): unknown },
        next: () => void,
      ) => void)
    | undefined
  plugin.configureServer({
    middlewares: {
      use(handler) {
        serve = handler
      },
    },
  })
  const context = { addWatchFile() {} }
  const first = await plugin.load.call(context, join(root, "hero.png?image"))
  const asset = plugin.nifraStaticAssets()[0]
  if (asset === undefined || serve === undefined) throw new Error("missing image dev middleware")
  for (const method of ["GET", "HEAD"]) {
    const headers = new Map<string, string>()
    let body: Uint8Array | undefined
    let fellThrough = false
    serve(
      { url: `/assets/${asset.fileName}`, method },
      {
        setHeader(name, value) {
          headers.set(name, value)
        },
        end(data) {
          body = data
        },
      },
      () => {
        fellThrough = true
      },
    )
    expect(fellThrough).toBe(false)
    expect(headers.get("content-type")).toBe("image/png")
    expect(headers.get("cache-control")).toContain("immutable")
    expect(body).toEqual(method === "HEAD" ? undefined : source)
  }
  writeFileSync(join(root, "hero.png"), new Uint8Array([...source, 0]))
  expect(await plugin.load.call(context, join(root, "hero.png?image"))).not.toBe(first)
  plugin.configResolved()
  expect(plugin.nifraStaticAssets()).toHaveLength(0)
})
