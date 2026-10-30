import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  emitPluginImages,
  isImageAssetUrl,
  pluginImageAssets,
  pluginImageResponse,
} from "../src/internal/image-assets.ts"

const source = new Uint8Array([1, 2, 3])
const fileName = `_images/${createHash("sha256").update(source).digest("hex")}.png`
const asset = { fileName, source }
const plugin = { nifraStaticAssets: () => [asset] }
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("image assets are emitted once, registered by URL and served with HEAD parity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-plugin-images-"))
  dirs.push(dir)
  expect(emitPluginImages([plugin, [plugin]], dir)).toEqual([`/assets/${fileName}`])
  expect(emitPluginImages([plugin], dir)).toEqual([`/assets/${fileName}`])
  expect(readFileSync(join(dir, fileName))).toEqual(Buffer.from(source))
  const response = pluginImageResponse([plugin], new Request(`http://localhost/assets/${fileName}`))
  expect(new Uint8Array(await response!.arrayBuffer())).toEqual(source)
  expect(response?.headers.get("content-type")).toBe("image/png")
  const head = pluginImageResponse(
    [plugin],
    new Request(`http://localhost/assets/${fileName}`, { method: "HEAD" }),
  )
  expect(await head?.text()).toBe("")
  expect(head?.headers.get("content-length")).toBe("3")
})

test("invalid paths, mismatched hashes and conflicting content are refused", () => {
  expect(() =>
    pluginImageAssets([{ nifraStaticAssets: () => [{ fileName: "../server.js", source }] }]),
  ).toThrow(/invalid/)
  expect(() =>
    pluginImageAssets([
      plugin,
      { nifraStaticAssets: () => [{ fileName, source: new Uint8Array([4]) }] },
    ]),
  ).toThrow(/conflicting/)
  const dir = mkdtempSync(join(tmpdir(), "nifra-plugin-images-"))
  dirs.push(dir)
  expect(() =>
    emitPluginImages(
      [{ nifraStaticAssets: () => [{ fileName, source: new Uint8Array([4]) }] }],
      dir,
    ),
  ).toThrow(/invalid/)
})

test("unregistered files, other plugins and non-read requests fall through", () => {
  expect(pluginImageAssets([{}, null])).toEqual([])
  expect(
    pluginImageResponse([plugin], new Request("http://localhost/assets/_images/nope.png")),
  ).toBeUndefined()
  expect(
    pluginImageResponse(
      [plugin],
      new Request(`http://localhost/assets/${fileName}`, { method: "POST" }),
    ),
  ).toBeUndefined()
})

for (const target of ["file", "directory"] as const) {
  test(`image output refuses a ${target} swapped to a symlink during validation`, () => {
    const dir = fs.realpathSync(mkdtempSync(join(tmpdir(), "nifra-image-race-")))
    const outside = fs.realpathSync(mkdtempSync(join(tmpdir(), "nifra-image-outside-")))
    dirs.push(dir, outside)
    emitPluginImages([plugin], dir)
    const leaf = fileName.slice("_images/".length)
    fs.writeFileSync(join(outside, leaf), source)
    const checked = target === "file" ? join(dir, fileName) : join(dir, "_images")
    const original = fs.lstatSync
    let swapped = false
    const intercepted = (path: fs.PathLike, options?: fs.StatSyncOptions) => {
      const result = original(path, options)
      if (String(path) === checked && !swapped) {
        swapped = true
        fs.renameSync(checked, `${checked}.held`)
        fs.symlinkSync(
          target === "file" ? join(outside, leaf) : outside,
          checked,
          target === "file" ? "file" : "dir",
        )
      }
      return result
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: forwards both arguments and the original result unchanged, preserving Node's bigint/throwIfNoEntry overloads.
    const held = spyOn(fs, "lstatSync").mockImplementation(intercepted as typeof fs.lstatSync)
    try {
      expect(() => emitPluginImages([plugin], dir)).toThrow()
      expect(swapped).toBe(true)
      expect(readFileSync(join(outside, leaf))).toEqual(Buffer.from(source))
    } finally {
      held.mockRestore()
    }
  })
}

test("existing image files are validated through their descriptor without being overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-image-corrupt-"))
  dirs.push(dir)
  emitPluginImages([plugin], dir)
  fs.writeFileSync(join(dir, fileName), new Uint8Array([3, 2, 1]))
  expect(() => emitPluginImages([plugin], dir)).toThrow(/invalid/)
  expect(readFileSync(join(dir, fileName))).toEqual(Buffer.from([3, 2, 1]))
  fs.writeFileSync(join(dir, fileName), new Uint8Array(10))
  expect(() => emitPluginImages([plugin], dir)).toThrow(/invalid/)
})

test("a plugin built for another publicPath is refused instead of emitting 404ing URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-image-prefix-"))
  dirs.push(dir)
  const rooted = { nifraStaticAssets: () => [asset], nifraPublicPath: "/static/" }
  expect(() => emitPluginImages([rooted], dir)).toThrow(/publicPath/)
  expect(() => emitPluginImages([rooted], dir, "/other/")).toThrow(/publicPath/)
  expect(emitPluginImages([rooted], dir, "/static")).toEqual([`/static/${fileName}`])
  expect(
    emitPluginImages(
      [{ nifraStaticAssets: () => [asset], nifraPublicPath: "https://cdn.example.com/a/" }],
      dir,
      "https://cdn.example.com/a/",
    ),
  ).toEqual([`https://cdn.example.com/a/${fileName}`])
  // A plugin that declares nothing is trusted to have used the build's prefix.
  expect(emitPluginImages([plugin], dir, "/static/")).toEqual([`/static/${fileName}`])
})

test("one plugin listed for both client and server contributes its assets once", () => {
  const big = new Uint8Array(4096).fill(7)
  const name = `_images/${createHash("sha256").update(big).digest("hex")}.png`
  const shared = { nifraStaticAssets: () => [{ fileName: name, source: big }] }
  const other = { nifraStaticAssets: () => [{ fileName: name, source: big.slice() }] }
  expect(pluginImageAssets([shared, shared, other]).map((file) => file.fileName)).toEqual([name])
  const changed = { nifraStaticAssets: () => [{ fileName: name, source: big.slice().fill(8) }] }
  expect(() => pluginImageAssets([shared, changed])).toThrow(/conflicting/)
})

test("files already emitted in this build are not validated and written again", () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-image-once-"))
  dirs.push(dir)
  const emitted = new Set<string>()
  expect(emitPluginImages([plugin], dir, "/assets/", emitted)).toEqual([`/assets/${fileName}`])
  expect(emitted).toEqual(new Set([fileName]))
  rmSync(join(dir, fileName))
  expect(emitPluginImages([plugin], dir, "/assets/", emitted)).toEqual([`/assets/${fileName}`])
  expect(fs.existsSync(join(dir, fileName))).toBe(false)
  expect(emitPluginImages([plugin], dir, "/assets/")).toEqual([`/assets/${fileName}`])
  expect(fs.existsSync(join(dir, fileName))).toBe(true)
})

test("image assets are recognised by URL so they can be kept out of bundle size reports", () => {
  const hash = "a".repeat(64)
  for (const ext of ["png", "jpg", "webp", "gif"])
    expect(isImageAssetUrl(`/assets/_images/${hash}.${ext}`)).toBe(true)
  for (const url of ["/assets/app-123.js", `/assets/_images/${hash}.svg`, "/assets/_images/x.png"])
    expect(isImageAssetUrl(url)).toBe(false)
})

test("a damaged emitted file names its path so it can be deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-image-damaged-"))
  dirs.push(dir)
  emitPluginImages([plugin], dir)
  fs.writeFileSync(join(dir, fileName), source.subarray(0, 1))
  expect(() => emitPluginImages([plugin], dir)).toThrow(/delete/)
  expect(fs.readdirSync(join(dir, "_images"))).toHaveLength(1)
})

test("losing the publication race to an identical writer is accepted, to a different one refused", () => {
  const lose = (race: (target: string) => void) =>
    spyOn(fs, "linkSync").mockImplementation((_from, target) => {
      race(String(target))
      throw Object.assign(new Error("exists"), { code: "EEXIST" })
    })
  const dir = mkdtempSync(join(tmpdir(), "nifra-image-race-win-"))
  const other = mkdtempSync(join(tmpdir(), "nifra-image-race-lose-"))
  const vanished = mkdtempSync(join(tmpdir(), "nifra-image-race-gone-"))
  dirs.push(dir, other, vanished)
  let spy = lose((target) => fs.writeFileSync(target, source))
  try {
    emitPluginImages([plugin], dir)
  } finally {
    spy.mockRestore()
  }
  expect(readFileSync(join(dir, fileName))).toEqual(Buffer.from(source))
  spy = lose((target) => fs.writeFileSync(target, new Uint8Array([9, 9, 9])))
  try {
    expect(() => emitPluginImages([plugin], other)).toThrow(/invalid existing image output/)
  } finally {
    spy.mockRestore()
  }
  spy = lose(() => {})
  try {
    expect(() => emitPluginImages([plugin], vanished)).toThrow(/invalid or conflicting/)
  } finally {
    spy.mockRestore()
  }
  for (const root of [dir, other, vanished])
    expect(fs.readdirSync(join(root, "_images")).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    )
})
