/** Build-only structural image-plugin hook; @nifrajs/web does not depend on an image codec/package. */
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { codeUnitOrder } from "./code-unit-order.ts"

interface ImageAsset {
  readonly fileName: string
  readonly source: Uint8Array
}
const assetName = /^_images\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/
const invalid = (): Error =>
  new Error("[nifra/web] image plugin returned an invalid or conflicting static asset")

export function pluginImageAssets(plugins: readonly unknown[] = []): readonly ImageAsset[] {
  const files = new Map<string, ImageAsset>()
  const visit = (plugin: unknown): void => {
    if (Array.isArray(plugin)) {
      for (const child of plugin) visit(child)
      return
    }
    if (typeof plugin !== "object" || plugin === null) return
    const hook: unknown = Reflect.get(plugin, "nifraStaticAssets")
    if (typeof hook !== "function") return
    const assets: unknown = Reflect.apply(hook, plugin, [])
    if (!Array.isArray(assets)) throw invalid()
    for (const asset of assets) {
      if (typeof asset !== "object" || asset === null) throw invalid()
      const fileName: unknown = Reflect.get(asset, "fileName")
      const source: unknown = Reflect.get(asset, "source")
      if (
        typeof fileName !== "string" ||
        !assetName.test(fileName) ||
        !(source instanceof Uint8Array)
      )
        throw invalid()
      const prior = files.get(fileName)
      if (
        prior !== undefined &&
        (prior.source.byteLength !== source.byteLength ||
          prior.source.some((byte, index) => byte !== source[index]))
      )
        throw invalid()
      files.set(fileName, { fileName, source })
    }
  }
  for (const plugin of plugins) visit(plugin)
  return [...files.values()].sort((a, b) => codeUnitOrder(a.fileName, b.fileName))
}

/** Validate every output before writing, and never follow an existing output symlink. */
export function emitPluginImages(
  plugins: readonly unknown[],
  outDir: string,
  publicPath = "/assets/",
): readonly string[] {
  const files = pluginImageAssets(plugins)
  for (const file of files) {
    const expected = assetName.exec(file.fileName)?.[1]
    if (createHash("sha256").update(file.source).digest("hex") !== expected) throw invalid()
  }
  if (files.length > 0) {
    mkdirSync(outDir, { recursive: true })
    const dir = join(outDir, "_images")
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw invalid()
    mkdirSync(dir, { recursive: true })
  }
  for (const file of files) {
    const path = join(outDir, file.fileName)
    if (existsSync(path)) {
      if (
        lstatSync(path).isSymbolicLink() ||
        createHash("sha256").update(readFileSync(path)).digest("hex") !==
          assetName.exec(file.fileName)?.[1]
      )
        throw invalid()
    } else writeFileSync(path, file.source, { flag: "wx" })
  }
  const prefix = publicPath.endsWith("/") ? publicPath : `${publicPath}/`
  return files.map((file) => `${prefix}${file.fileName}`)
}

/** Native Bun dev serves the same in-memory hashed bytes as the Vite image middleware. */
export function pluginImageResponse(
  plugins: readonly unknown[],
  request: Request,
): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  const path = new URL(request.url).pathname
  if (!path.startsWith("/assets/_images/")) return undefined
  const asset = pluginImageAssets(plugins).find((file) => `/assets/${file.fileName}` === path)
  if (asset === undefined) return undefined
  const extension = asset.fileName.slice(asset.fileName.lastIndexOf(".") + 1)
  return new Response(request.method === "HEAD" ? null : asset.source.slice().buffer, {
    headers: {
      "content-type": `image/${extension === "jpg" ? "jpeg" : extension}`,
      "content-length": String(asset.source.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  })
}
