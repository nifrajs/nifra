import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  emitPluginImages,
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
